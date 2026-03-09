-- 017: Detección automática de transferencias internas en el servidor
--
-- Agrega transfer_pair_id para enlazar bidireccionalmente dos movimientos que
-- el sistema detecta como un probable traslado entre cuentas propias del usuario.
--
-- Criterios de emparejamiento automático (estrategia A — par simétrico):
--   • mismo user_id
--   • direction opuesta (un crédito + un débito)
--   • |amount_a - amount_b| < 1 COP  (tolerancia mínima por redondeo)
--   • |email_date_a - email_date_b| < 48 horas
--   • is_internal_transfer IS NULL  (ninguno revisado aún)
--   • transfer_pair_id IS NULL      (ninguno ya emparejado)
--
-- Estados:
--   transfer_pair_id IS NULL  = movimiento sin par conocido (estrategia B queda
--                               al cliente: contraparte menciona banco propio)
--   transfer_pair_id = uuid   = par auto-detectado, pendiente confirmación del usuario
--   is_internal_transfer = true  = usuario confirmó → excluido de totales
--   is_internal_transfer = false = usuario descartó  → ambos lados se desvinculan

-- ── 1. Columna ────────────────────────────────────────────────────────────────
ALTER TABLE public.pending_movements
  ADD COLUMN IF NOT EXISTS transfer_pair_id UUID
    REFERENCES public.pending_movements(id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_pending_movements_pair
  ON public.pending_movements (transfer_pair_id)
  WHERE transfer_pair_id IS NOT NULL;

-- ── 2. Función: enlazar par para un movimiento dado ──────────────────────────
CREATE OR REPLACE FUNCTION public.link_transfer_pair(p_movement_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id    UUID;
  v_amount     NUMERIC;
  v_direction  TEXT;
  v_email_date TIMESTAMPTZ;
  v_pair_id    UUID;
BEGIN
  -- Leer datos del movimiento objetivo
  SELECT user_id, amount, direction, email_date
    INTO v_user_id, v_amount, v_direction, v_email_date
    FROM public.pending_movements
   WHERE id                   = p_movement_id
     AND status               = 'confirmed'
     AND is_internal_transfer IS NULL
     AND transfer_pair_id     IS NULL;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Buscar par simétrico: opuesto en dirección, mismo importe, ventana 48 h
  SELECT id INTO v_pair_id
    FROM public.pending_movements
   WHERE user_id              = v_user_id
     AND id                  <> p_movement_id
     AND status               = 'confirmed'
     AND is_internal_transfer IS NULL
     AND transfer_pair_id     IS NULL
     AND direction            <> v_direction
     AND ABS(amount - v_amount) < 1
     AND v_email_date         IS NOT NULL
     AND email_date           IS NOT NULL
     AND ABS(EXTRACT(EPOCH FROM (email_date - v_email_date))) < 172800  -- 48 h
   ORDER BY
     ABS(amount - v_amount),
     ABS(EXTRACT(EPOCH FROM (email_date - v_email_date)))
   LIMIT 1;

  IF v_pair_id IS NOT NULL THEN
    -- Enlace bidireccional (DEFERRABLE permite actualizar ambas filas en la misma tx)
    UPDATE public.pending_movements SET transfer_pair_id = p_movement_id WHERE id = v_pair_id;
    UPDATE public.pending_movements SET transfer_pair_id = v_pair_id    WHERE id = p_movement_id;
  END IF;
END;
$$;

-- ── 3. Trigger: auto-enlazar al insertar un movimiento confirmado ─────────────
CREATE OR REPLACE FUNCTION public.trg_auto_link_transfer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'confirmed' AND NEW.is_internal_transfer IS NULL THEN
    PERFORM public.link_transfer_pair(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_link_transfer_after_insert ON public.pending_movements;
CREATE TRIGGER trg_auto_link_transfer_after_insert
  AFTER INSERT ON public.pending_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_link_transfer();

-- ── 4. Backfill: enlazar pares ya existentes ──────────────────────────────────
DO $$
DECLARE
  v_id UUID;
BEGIN
  FOR v_id IN
    SELECT id
      FROM public.pending_movements
     WHERE status               = 'confirmed'
       AND is_internal_transfer IS NULL
       AND transfer_pair_id     IS NULL
     ORDER BY email_date DESC
  LOOP
    PERFORM public.link_transfer_pair(v_id);
  END LOOP;
END;
$$;
