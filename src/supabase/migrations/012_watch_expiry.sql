-- 012: Tracking de expiración del Gmail Watch por cuenta
--
-- El Gmail Watch expira a los 7 días. Para renovarlo automáticamente necesitamos
-- saber cuándo expira cada Watch. Esta migración:
--   1. Añade watch_expiry a private.oauth_tokens
--   2. RPC get_gmail_accounts_for_renewal — cuentas cuyo Watch vence pronto o nunca se registró
--   3. RPC update_gmail_watch_expiry     — actualiza la expiración tras renovar

-- ── 1. Columna watch_expiry ───────────────────────────────────────────────────
ALTER TABLE private.oauth_tokens
  ADD COLUMN IF NOT EXISTS watch_expiry TIMESTAMPTZ;

-- ── 2. RPC: cuentas que necesitan renovación ─────────────────────────────────
-- Devuelve todas las cuentas Gmail activas cuyo Watch expira dentro de
-- p_window_hours horas (default 48h) o que nunca han tenido Watch registrado.
CREATE OR REPLACE FUNCTION public.get_gmail_accounts_for_renewal(
  p_window_hours INT DEFAULT 48
)
RETURNS TABLE(user_id UUID, email_address TEXT, refresh_token TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, vault
AS $$
BEGIN
  RETURN QUERY
    SELECT
      t.user_id,
      t.email_address,
      ds.decrypted_secret AS refresh_token
    FROM private.oauth_tokens t
    JOIN vault.decrypted_secrets ds ON ds.id = t.refresh_token_secret_id
    WHERE t.provider  = 'gmail'
      AND t.is_active = TRUE
      AND (
        t.watch_expiry IS NULL
        OR t.watch_expiry < NOW() + (p_window_hours || ' hours')::INTERVAL
      );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_gmail_accounts_for_renewal(INT) TO service_role;

-- ── 3. RPC: actualizar expiración tras renovar Watch ─────────────────────────
-- p_expiry_ms: valor Unix en milisegundos que devuelve la Gmail Watch API.
CREATE OR REPLACE FUNCTION public.update_gmail_watch_expiry(
  p_user_id   UUID,
  p_email     TEXT,
  p_expiry_ms BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  UPDATE private.oauth_tokens
     SET watch_expiry = TO_TIMESTAMP(p_expiry_ms / 1000.0)
   WHERE user_id      = p_user_id
     AND email_address = p_email
     AND provider      = 'gmail'
     AND is_active     = TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_gmail_watch_expiry(UUID, TEXT, BIGINT) TO service_role;
