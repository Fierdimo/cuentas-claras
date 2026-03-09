-- 014: Fix pending_movements unique constraint
--
-- Problema: la migración 013 creó un índice único PARCIAL:
--   CREATE UNIQUE INDEX ... ON pending_movements (user_id, gmail_msg_id)
--   WHERE gmail_msg_id IS NOT NULL;
--
-- PostgreSQL / PostgREST no puede usar índices parciales con la cláusula
--   ON CONFLICT (user_id, gmail_msg_id)
-- produciendo el error: 42P10 "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification"
--
-- Solución: reemplazar con un UNIQUE CONSTRAINT sin predicado WHERE.
-- Los NULL en gmail_msg_id no chocan entre sí (NULL != NULL en UNIQUE),
-- por lo que la semántica de deduplicación se preserva correctamente.

-- 1. Eliminar el índice parcial
DROP INDEX IF EXISTS public.idx_pending_movements_msg_id;

-- 2. Crear UNIQUE CONSTRAINT nombrado que PostgREST puede usar con ON CONFLICT
ALTER TABLE public.pending_movements
  ADD CONSTRAINT pending_movements_user_msg_id_key
  UNIQUE (user_id, gmail_msg_id);

-- 3. Re-crear el índice de búsqueda por usuario (no se toca, es independiente)
-- idx_pending_movements_user ya existe desde la migración 013 — no hay que recrearlo.
