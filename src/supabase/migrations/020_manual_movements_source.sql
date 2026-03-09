-- Migration 020: add source column to pending_movements
-- Allows distinguishing auto-detected movements (email) from user-created ones (manual).

ALTER TABLE pending_movements
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'email';

-- Index to quickly list manual entries per user
CREATE INDEX IF NOT EXISTS idx_pending_movements_source
  ON pending_movements (user_id, source)
  WHERE source = 'manual';

-- Permitir INSERT desde cliente autenticado (movimientos manuales)
CREATE POLICY "usuarios_insertan_sus_movimientos"
  ON public.pending_movements
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Permitir DELETE desde cliente autenticado (solo movimientos manuales)
CREATE POLICY "usuarios_eliminan_sus_movimientos_manuales"
  ON public.pending_movements
  FOR DELETE TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND source = 'manual'
  );