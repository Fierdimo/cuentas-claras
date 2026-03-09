-- 016: Columna is_internal_transfer para marcar transferencias entre cuentas propias
--
-- null  = no revisado (se detecta automáticamente en el cliente si hay par)
-- true  = confirmado como transferencia interna → excluido de totales
-- false = el usuario indicó explícitamente que NO es una transferencia (o quiere
--         conservar ambos registros por razones fiscales)

ALTER TABLE public.pending_movements
  ADD COLUMN IF NOT EXISTS is_internal_transfer boolean DEFAULT null;

-- Índice para consultas rápidas por usuario sobre transferencias confirmadas
CREATE INDEX IF NOT EXISTS idx_pending_movements_transfer
  ON public.pending_movements (user_id, is_internal_transfer)
  WHERE is_internal_transfer IS NOT NULL;
