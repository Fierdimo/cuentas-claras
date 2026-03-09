-- 013: Detección de correos bancarios y movimientos pendientes
--
-- Tablas:
--   bank_email_parsers   — reglas de extracción aprendidas por remitente (globales)
--   pending_movements    — movimientos detectados, pendientes de confirmación del usuario
--
-- Columna nueva en oauth_tokens:
--   bank_sync_completed_at — timestamp del último scan de correos bancarios (por cuenta)
--
-- RPCs:
--   get_bank_sync_info(user_id, email?)       — refresh_token + last_bank_synced_at
--   mark_bank_sync_completed(user_id, email?) — actualiza bank_sync_completed_at
--   upsert_bank_parser(sender, bank, rules)   — guarda/actualiza reglas aprendidas

-- ── 1. Reglas aprendidas por remitente ───────────────────────────────────────
-- Tabla global (sin user_id): las reglas son iguales para todos los usuarios.
-- Cada vez que Perplexity parsea un nuevo formato, las reglas quedan guardadas
-- para que el siguiente email del mismo remitente no necesite llamar a Perplexity.

CREATE TABLE IF NOT EXISTS public.bank_email_parsers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_email  TEXT        NOT NULL UNIQUE,   -- 'notificaciones@nequi.com.co'
  bank_name     TEXT        NOT NULL,
  rules         JSONB       NOT NULL,          -- reglas de extracción (ver estructura abajo)
  sample_count  INT         NOT NULL DEFAULT 1, -- cuántos emails confirmaron estas reglas
  confidence    NUMERIC(3,2) NOT NULL DEFAULT 0.80,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Estructura de `rules` (JSONB):
-- {
--   "amount_regex":              "<regex>",
--   "direction_credit_keywords": ["recibiste", "abono", "consignación"],
--   "direction_debit_keywords":  ["enviaste", "compra", "débito"],
--   "counterpart_regex":         "<regex>" | null,
--   "account_regex":             "<regex>" | null,
--   "currency":                  "COP"
-- }

-- authenticated puede leer las reglas (transparencia, sin datos sensibles)
REVOKE ALL ON public.bank_email_parsers FROM anon;
GRANT SELECT ON public.bank_email_parsers TO authenticated;
GRANT ALL ON public.bank_email_parsers TO service_role;

-- ── 2. Movimientos pendientes de confirmación ────────────────────────────────
-- Estado 'pending_confirmation': el usuario debe tocar "Confirmar" o "Ignorar".
-- NUNCA se registra automáticamente.

CREATE TABLE IF NOT EXISTS public.pending_movements (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_msg_id  TEXT,                          -- para deduplicación
  source        TEXT        NOT NULL DEFAULT 'email',
  bank_name     TEXT,
  sender_email  TEXT,
  amount        NUMERIC(15,2) NOT NULL,
  direction     TEXT        NOT NULL CHECK (direction IN ('credit', 'debit')),
  currency      TEXT        NOT NULL DEFAULT 'COP',
  counterpart   TEXT,                          -- nombre de quien envió / recibió
  account_last4 TEXT,                          -- últimos 4 dígitos de la cuenta
  email_date    TIMESTAMPTZ,                   -- timestamp del correo original
  body_snippet  TEXT,                          -- primeros 500 chars del body (auditoría)
  parser_used   TEXT        NOT NULL DEFAULT 'known'
                            CHECK (parser_used IN ('known', 'learned', 'perplexity')),
  status        TEXT        NOT NULL DEFAULT 'pending_confirmation'
                            CHECK (status IN ('pending_confirmation', 'confirmed', 'rejected', 'ignored')),
  confirmed_at  TIMESTAMPTZ,
  rejected_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice único para evitar duplicados del mismo mensaje
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_movements_msg_id
  ON public.pending_movements (user_id, gmail_msg_id)
  WHERE gmail_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_movements_user
  ON public.pending_movements (user_id, created_at DESC);

ALTER TABLE public.pending_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "usuarios_ven_sus_movimientos" ON public.pending_movements;
CREATE POLICY "usuarios_ven_sus_movimientos"
  ON public.pending_movements FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "usuarios_actualizan_sus_movimientos" ON public.pending_movements;
CREATE POLICY "usuarios_actualizan_sus_movimientos"
  ON public.pending_movements FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

GRANT ALL ON public.pending_movements TO service_role;

-- ── 3. Columna bank_sync_completed_at en oauth_tokens ────────────────────────
ALTER TABLE private.oauth_tokens
  ADD COLUMN IF NOT EXISTS bank_sync_completed_at TIMESTAMPTZ;

-- ── 4. RPC: obtener info para bank sync ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_bank_sync_info(
  p_user_id UUID,
  p_email   TEXT DEFAULT NULL
)
RETURNS TABLE(refresh_token TEXT, last_bank_synced_at TIMESTAMPTZ, email_address TEXT)
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
  SELECT t.refresh_token_secret_id, t.bank_sync_completed_at, t.email_address
    INTO v_secret_id, v_synced_at, v_email
    FROM private.oauth_tokens t
   WHERE t.user_id   = p_user_id
     AND t.provider  = 'gmail'
     AND t.is_active = TRUE
     AND (p_email IS NULL OR t.email_address = p_email)
   ORDER BY t.created_at ASC
   LIMIT 1;

  IF v_secret_id IS NULL THEN RETURN; END IF;

  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets WHERE id = v_secret_id;

  RETURN QUERY SELECT v_token, v_synced_at, v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_bank_sync_info(UUID, TEXT) TO service_role;

-- ── 5. RPC: marcar bank sync completado ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_bank_sync_completed(
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
     SET bank_sync_completed_at = NOW()
   WHERE user_id   = p_user_id
     AND provider  = 'gmail'
     AND is_active = TRUE
     AND (p_email IS NULL OR email_address = p_email);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_bank_sync_completed(UUID, TEXT) TO service_role;

-- ── 6. RPC: upsert de reglas aprendidas (llamada desde Edge Function) ─────────
CREATE OR REPLACE FUNCTION public.upsert_bank_parser(
  p_sender_email TEXT,
  p_bank_name    TEXT,
  p_rules        JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.bank_email_parsers (sender_email, bank_name, rules)
    VALUES (p_sender_email, p_bank_name, p_rules)
  ON CONFLICT (sender_email) DO UPDATE
    SET rules        = EXCLUDED.rules,
        sample_count = bank_email_parsers.sample_count + 1,
        confidence   = LEAST(0.99, bank_email_parsers.confidence + 0.02),
        updated_at   = NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_bank_parser(TEXT, TEXT, JSONB) TO service_role;
