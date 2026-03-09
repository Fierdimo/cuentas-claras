-- 010: RPC que devuelve refresh token + fecha de última sincronización en un solo paso.
-- Permite a backfill-gmail determinar si es el escaneo inicial (90 días) o incremental.
--
-- Reemplaza las llamadas separadas a get_gmail_refresh_token + consulta de backfill_completed_at.
-- backfill_completed_at sirve como "last_synced_at": se actualiza en cada sync completado.

CREATE OR REPLACE FUNCTION public.get_gmail_sync_info(p_user_id UUID)
RETURNS TABLE(refresh_token TEXT, last_synced_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, vault
AS $$
DECLARE
  v_secret_id UUID;
  v_token     TEXT;
  v_synced_at TIMESTAMPTZ;
BEGIN
  SELECT refresh_token_secret_id, backfill_completed_at
    INTO v_secret_id, v_synced_at
    FROM private.oauth_tokens
   WHERE user_id  = p_user_id
     AND provider = 'gmail'
     AND is_active = TRUE
   LIMIT 1;

  IF v_secret_id IS NULL THEN
    RETURN;
  END IF;

  SELECT decrypted_secret
    INTO v_token
    FROM vault.decrypted_secrets
   WHERE id = v_secret_id;

  RETURN QUERY SELECT v_token, v_synced_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_gmail_sync_info(UUID) TO service_role;
