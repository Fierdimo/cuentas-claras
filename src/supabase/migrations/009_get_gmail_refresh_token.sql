-- Migration 009: RPC que obtiene y desencripta el refresh token de Gmail en un solo paso.
-- vault_decrypted_secret NO existe como función RPC — solo como vista vault.decrypted_secrets.
-- Esta función accede a ambos (private.oauth_tokens + vault) con SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.get_gmail_refresh_token(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, vault
AS $$
DECLARE
  v_secret_id UUID;
  v_token     TEXT;
BEGIN
  SELECT refresh_token_secret_id
    INTO v_secret_id
    FROM private.oauth_tokens
   WHERE user_id  = p_user_id
     AND provider = 'gmail'
     AND is_active = TRUE
   LIMIT 1;

  IF v_secret_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret
    INTO v_token
    FROM vault.decrypted_secrets
   WHERE id = v_secret_id;

  RETURN v_token;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_gmail_refresh_token(UUID) TO service_role;
