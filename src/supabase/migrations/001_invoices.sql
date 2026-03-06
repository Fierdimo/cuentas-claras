-- Migración 001: Tabla principal de facturas
-- Ejecutar en: Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS public.invoices (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  country_code   TEXT        NOT NULL DEFAULT 'CO',
  -- CanonicalInvoice completo serializado como JSONB
  invoice_data   JSONB       NOT NULL,
  -- Campos indexados para búsqueda y filtros (duplican datos del JSONB para performance)
  invoice_number TEXT        NOT NULL,
  issuer_tax_id  TEXT,
  issuer_name    TEXT,
  total_amount   NUMERIC(15, 2),
  currency       TEXT        DEFAULT 'COP',
  issue_date     DATE,
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','approved','rejected','cancelled','locked')),
  source         TEXT        NOT NULL DEFAULT 'email'
                             CHECK (source IN ('email','qr','manual')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete: la fila permanece hasta purga GDPR a 90 días
  deleted_at     TIMESTAMPTZ,
  -- Concurrencia optimista: incrementar en cada UPDATE
  version        INTEGER     NOT NULL DEFAULT 1
);

-- Índices para queries frecuentes
CREATE INDEX IF NOT EXISTS idx_invoices_user_date
  ON public.invoices (user_id, issue_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_user_status
  ON public.invoices (user_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_user_issuer
  ON public.invoices (user_id, issuer_tax_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_cufe
  ON public.invoices USING gin ((invoice_data -> 'authorizationCode') jsonb_path_ops);

-- Habilitar RLS (sin políticas = ningún acceso desde el cliente)
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- Publicar cambios para Supabase Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.invoices;

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_set_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
