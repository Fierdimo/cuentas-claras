-- 015: Promocionar movimientos existentes a confirmed + resetear cursor de escaneo
--
-- Contexto:
--   Los movimientos detectados antes de la v2 del edge function están almacenados
--   con status='pending_confirmation'. El nuevo flujo (mínima fricción) los inserta
--   directamente como 'confirmed'. Esta migración sincroniza los datos existentes.

-- 1. Promover todos los movimientos pendientes de confirmación a confirmados.
UPDATE public.pending_movements
SET   status       = 'confirmed',
      confirmed_at = COALESCE(confirmed_at, email_date, created_at)
WHERE status = 'pending_confirmation';

-- 2. Resetear el cursor de escaneo bancario para que detect-bank-emails
--    vuelva a revisar correos recientes y los inserte como 'confirmed'.
--    (Los ya existentes no se duplicarán gracias al UNIQUE CONSTRAINT.)
UPDATE private.oauth_tokens
SET   bank_sync_completed_at = NULL
WHERE provider   = 'gmail'
  AND is_active  = TRUE;
