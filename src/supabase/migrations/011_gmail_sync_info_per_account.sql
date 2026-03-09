-- 011: Extender RPCs de Gmail para soportar múltiples cuentas por usuario.
--
-- get_gmail_sync_info: añade p_email (opcional) para consultar una cuenta específica.
--   Si es NULL, usa la primera cuenta activa (retrocompatible con 010).
--   Ahora también devuelve email_address para facilitar el logging.
--
-- mark_backfill_completed: añade p_email (opcional) para marcar solo esa cuenta.
--   Si es NULL, marca todas las cuentas activas del usuario (retrocompatible con 008).

-- Eliminar versiones anteriores (firmas distintas → no son reemplazables con OR REPLACE)
DROP FUNCTION IF EXISTS public.get_gmail_sync_info(UUID);
DROP FUNCTION IF EXISTS public.mark_backfill_completed(UUID);

CREATE OR REPLACE FUNCTION public.get_gmail_sync_info(
  p_user_id UUID,
  p_email   TEXT DEFAULT NULL
)
RETURNS TABLE(refresh_token TEXT, last_synced_at TIMESTAMPTZ, email_address TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, vault
AS $$
DECLARE
  v_secret_id UUID;
  v_token     TEXT;
  v_synced_at TIMESTAMPTZ;
  v_email     TEXT;
BEGIN
  SELECT t.refresh_token_secret_id, t.backfill_completed_at, t.email_address
    INTO v_secret_id, v_synced_at, v_email
    FROM private.oauth_tokens t
   WHERE t.user_id   = p_user_id
     AND t.provider  = 'gmail'
     AND t.is_active = TRUE
     AND (p_email IS NULL OR t.email_address = p_email)
   ORDER BY t.created_at ASC
   LIMIT 1;

  IF v_secret_id IS NULL THEN
    RETURN;
  END IF;

  SELECT decrypted_secret
    INTO v_token
    FROM vault.decrypted_secrets
   WHERE id = v_secret_id;

  RETURN QUERY SELECT v_token, v_synced_at, v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_gmail_sync_info(UUID, TEXT) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_backfill_completed(
  p_user_id UUID,
  p_email   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  UPDATE private.oauth_tokens
     SET backfill_completed_at = NOW()
   WHERE user_id   = p_user_id
     AND provider  = 'gmail'
     AND is_active = true
     AND (p_email IS NULL OR email_address = p_email);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_backfill_completed(UUID, TEXT) TO service_role;
