-- ── 019_invoice_movement_link.sql ────────────────────────────────────────────
-- Vincula movimientos bancarios con facturas electrónicas.
-- Un movimiento puede tener una factura confirmada (linked_invoice_id) y
-- una factura puede referir al movimiento que la pagó (linked_movement_id).
-- NULL en ambos campos significa "sin vínculo confirmado".

ALTER TABLE public.pending_movements
  ADD COLUMN IF NOT EXISTS linked_invoice_id UUID
    REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS linked_movement_id UUID
    REFERENCES public.pending_movements(id) ON DELETE SET NULL;

-- Índices para lookups rápidos
CREATE INDEX IF NOT EXISTS idx_pending_movements_linked_invoice
  ON public.pending_movements (user_id, linked_invoice_id)
  WHERE linked_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_linked_movement
  ON public.invoices (user_id, linked_movement_id)
  WHERE linked_movement_id IS NOT NULL;
