-- Migración 005: Funciones helper para Vault
-- Permite a las Edge Functions (service_role) hacer upsert de secrets
-- sin tener que acceder directamente al schema vault.

-- upsert_vault_secret: crea o actualiza un secret por nombre.
-- Devuelve el UUID del secret.
CREATE OR REPLACE FUNCTION public.upsert_vault_secret(
  p_secret      TEXT,
  p_name        TEXT,
  p_description TEXT DEFAULT ''
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Buscar si ya existe un secret con ese nombre
  SELECT id INTO v_id
    FROM vault.secrets
   WHERE name = p_name
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Actualizar el secret existente
    PERFORM vault.update_secret(v_id, p_secret, p_name, p_description);
    RETURN v_id;
  ELSE
    -- Crear nuevo secret
    v_id := vault.create_secret(p_secret, p_name, p_description);
    RETURN v_id;
  END IF;
END;
$$;

-- Solo service_role puede llamar esta función
REVOKE ALL ON FUNCTION public.upsert_vault_secret FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_vault_secret TO service_role;
