-- Migración 004: Audit log, GDPR y renovación de Gmail Watch
-- Ejecutar DESPUÉS de 003_oauth_tokens.sql
-- REQUIERE: pg_cron y pg_net habilitados en Supabase

-- ── Audit log ────────────────────────────────────────────────────────────────
-- Tabla append-only: solo INSERT, sin UPDATE ni DELETE.
-- Registra accesos y operaciones sensibles para cumplimiento Ley 1581.

CREATE TABLE IF NOT EXISTS private.audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,
  -- VIEW | EXPORT | SOFT_DELETE | GDPR_ERASURE | OAUTH_CONNECTED | OAUTH_REVOKED
  -- INVOICE_PARSED | INVOICE_LOCKED | SYNC_UPLOAD | SYNC_DOWNLOAD
  resource_type TEXT        NOT NULL DEFAULT 'invoice',
  resource_id   UUID,
  ip_address    INET,
  user_agent    TEXT,
  metadata      JSONB,
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  performed_by  TEXT        NOT NULL DEFAULT 'user'
  -- 'user' | 'system' | 'edge_function'
);

-- No hay trigger de updated_at (append-only)
REVOKE ALL ON private.audit_log FROM anon, authenticated;
GRANT ALL ON private.audit_log TO service_role;

-- Los usuarios pueden ver su propio audit log (transparencia Ley 1581)
CREATE POLICY "usuarios_ven_su_audit_log"
  ON private.audit_log
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

ALTER TABLE private.audit_log ENABLE ROW LEVEL SECURITY;

-- ── Función de borrado GDPR ───────────────────────────────────────────────────
-- Llamada desde Edge Function cuando el usuario solicita eliminar su cuenta.
CREATE OR REPLACE FUNCTION private.erase_user_data(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private
AS $$
BEGIN
  -- 1. Soft-delete de todas las facturas (ya sin datos sensibles en JSONB)
  UPDATE public.invoices
  SET
    deleted_at   = now(),
    invoice_data = jsonb_build_object('erased', true, 'erasedAt', now()::text),
    issuer_name  = null,
    issuer_tax_id = null
  WHERE user_id = p_user_id;

  -- 2. Desactivar tokens OAuth
  UPDATE private.oauth_tokens
  SET is_active = FALSE, updated_at = now()
  WHERE user_id = p_user_id;

  -- 3. Registrar en audit log
  INSERT INTO private.audit_log (user_id, action, resource_type, performed_by)
  VALUES (p_user_id, 'GDPR_ERASURE', 'user', 'system');
END;
$$;

REVOKE ALL ON FUNCTION private.erase_user_data(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.erase_user_data(UUID) TO service_role;

-- ── pg_cron: Purga física GDPR a 90 días ─────────────────────────────────────
-- Ejecuta cada domingo a las 3:00 AM UTC
SELECT cron.schedule(
  'gdpr-purge-deleted-invoices',
  '0 3 * * 0',
  $$
    DELETE FROM public.invoices
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '90 days';
  $$
);

-- ── pg_cron: Renovar Gmail Watch cada 6 días ─────────────────────────────────
-- El Gmail Watch expira a los 7 días; lo renovamos a los 6 para tener margen.
-- La Edge Function renew-gmail-watch itera todos los tokens activos.
SELECT cron.schedule(
  'renew-gmail-watch',
  '0 6 */6 * *',
  $$
    SELECT net.http_post(
      url     := current_setting('app.edge_function_base_url', true) || '/renew-gmail-watch',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
      ),
      body    := '{}'::jsonb
    );
  $$
);
