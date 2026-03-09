-- 018: Aprendizaje de identidades propias del usuario
--
-- Cuando el usuario confirma que un movimiento es una transferencia interna,
-- el nombre de la contraparte (counterpart) se guarda aquí.
-- En el futuro, cualquier movimiento cuya contraparte coincida con un nombre
-- almacenado se marcará automáticamente como posible transferencia propia.

CREATE TABLE IF NOT EXISTS public.user_own_counterparts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,          -- valor original de la contraparte
  name_lower  TEXT        NOT NULL,          -- lowercase para búsqueda eficiente
  source_bank TEXT,                          -- banco del que provino el aprendizaje
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, name_lower)
);

ALTER TABLE public.user_own_counterparts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own counterparts"
  ON public.user_own_counterparts
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_own_counterparts_user
  ON public.user_own_counterparts (user_id);
