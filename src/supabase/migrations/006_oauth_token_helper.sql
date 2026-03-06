-- Migración 006: Helper para insertar/actualizar oauth_tokens desde Edge Functions

-- Agrega columna expo_push_token si no existe
ALTER TABLE private.oauth_tokens
  ADD COLUMN IF NOT EXISTS expo_push_token TEXT;

-- Función wrapper para upsert de oauth_tokens
-- Solo service_role puede llamarla (las Edge Functions usan service_role)
CREATE OR REPLACE FUNCTION public.upsert_oauth_token(
  p_user_id                 UUID,
  p_provider                TEXT,
  p_email_address           TEXT,
  p_refresh_token_secret_id UUID,
  p_token_scope             TEXT[],
  p_expo_push_token         TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  INSERT INTO private.oauth_tokens (
    user_id,
    provider,
    email_address,
    refresh_token_secret_id,
    token_scope,
    is_active,
    last_refreshed,
    expo_push_token
  ) VALUES (
    p_user_id,
    p_provider,
    p_email_address,
    p_refresh_token_secret_id,
    p_token_scope,
    TRUE,
    NOW(),
    p_expo_push_token
  )
  ON CONFLICT (user_id, provider, email_address)
  DO UPDATE SET
    refresh_token_secret_id = EXCLUDED.refresh_token_secret_id,
    token_scope             = EXCLUDED.token_scope,
    is_active               = TRUE,
    last_refreshed          = NOW(),
    expo_push_token         = COALESCE(EXCLUDED.expo_push_token, private.oauth_tokens.expo_push_token),
    updated_at              = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_oauth_token FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_oauth_token TO service_role;
