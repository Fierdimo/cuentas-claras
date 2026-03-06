-- 008: RPCs para leer private.oauth_tokens desde Edge Functions.
-- El schema private no está expuesto en PostgREST, así que las Edge Functions
-- no pueden usar .schema('private') directamente. Estas funciones SECURITY DEFINER
-- actúan como puente seguro.

-- Devuelve el secret_id del refresh token de Gmail para un usuario
CREATE OR REPLACE FUNCTION public.get_gmail_refresh_secret_id(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_secret_id UUID;
BEGIN
  SELECT refresh_token_secret_id INTO v_secret_id
  FROM private.oauth_tokens
  WHERE user_id    = p_user_id
    AND provider   = 'gmail'
    AND is_active  = true
  LIMIT 1;
  RETURN v_secret_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_gmail_refresh_secret_id(UUID) TO service_role;

-- Marca el backfill como completado
CREATE OR REPLACE FUNCTION public.mark_backfill_completed(p_user_id UUID)
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
    AND is_active = true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_backfill_completed(UUID) TO service_role;
