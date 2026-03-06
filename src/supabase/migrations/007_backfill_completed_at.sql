-- 007: Registrar si el backfill inicial ya se ejecutó para cada cuenta conectada.
-- Permite auto-disparar el escaneo cuando el usuario ya tenía la cuenta conectada
-- antes de que se implementara el backfill, o si la app cerró a mitad de escaneo.

ALTER TABLE private.oauth_tokens
  ADD COLUMN IF NOT EXISTS backfill_completed_at TIMESTAMPTZ;

-- Recrear vista pública con el nuevo campo
DROP VIEW IF EXISTS public.connected_accounts;
CREATE VIEW public.connected_accounts
  WITH (security_invoker=false)
AS
  SELECT
    id,
    provider,
    email_address         AS "emailAddress",
    is_active             AS "isActive",
    last_refreshed        AS "lastRefreshed",
    backfill_completed_at AS "backfillCompletedAt"
  FROM private.oauth_tokens
  WHERE user_id = auth.uid();

GRANT SELECT ON public.connected_accounts TO authenticated;
