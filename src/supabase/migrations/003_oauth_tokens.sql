-- Migración 003: Almacenamiento seguro de tokens OAuth
-- Ejecutar DESPUÉS de 001_invoices.sql
-- REQUIERE: Supabase Vault habilitado (Dashboard → Database → Extensions → pgsodium + supabase_vault)

-- Crear esquema privado no expuesto por PostgREST
CREATE SCHEMA IF NOT EXISTS private;

-- Tabla de tokens OAuth
-- Los refresh tokens NO se almacenan en texto plano:
-- se guardan en Supabase Vault y aquí solo se referencia el ID del secret.
CREATE TABLE IF NOT EXISTS private.oauth_tokens (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider                TEXT        NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  email_address           TEXT        NOT NULL,
  -- ID del secret en vault.secrets (el token real está cifrado en Vault)
  refresh_token_secret_id UUID,
  -- Scopes autorizados por el usuario
  token_scope             TEXT[]      DEFAULT '{}',
  is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  last_refreshed          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Expiry del watch de Gmail (se renueva cada 6 días vía pg_cron)
  gmail_watch_expiry      TIMESTAMPTZ,
  gmail_history_id        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, email_address)
);

-- Revocar acceso a roles de cliente — solo service_role puede acceder
REVOKE ALL ON private.oauth_tokens FROM anon, authenticated;
GRANT ALL ON private.oauth_tokens TO service_role;

-- Trigger para updated_at
CREATE TRIGGER oauth_tokens_set_updated_at
  BEFORE UPDATE ON private.oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Vista segura para que el cliente vea SUS cuentas conectadas (sin tokens)
-- Esta vista está en el schema public y expuesta por PostgREST con RLS
CREATE VIEW public.connected_accounts AS
  SELECT
    id,
    user_id,
    provider,
    email_address,
    is_active,
    last_refreshed,
    created_at
  FROM private.oauth_tokens;

-- RLS en la vista (aplica sobre la tabla subyacente via SECURITY INVOKER)
ALTER VIEW public.connected_accounts SET (security_invoker = true);

CREATE POLICY "usuarios_ven_sus_cuentas"
  ON private.oauth_tokens
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);
