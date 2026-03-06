-- Migración 002: Políticas de Row Level Security
-- Ejecutar DESPUÉS de 001_invoices.sql

-- ── SELECT ────────────────────────────────────────────────────────────────────
-- El usuario solo puede ver sus propias facturas no eliminadas.
-- (select auth.uid()) en subquery: Postgres cachea el resultado por statement.
CREATE POLICY "usuarios_ven_sus_facturas"
  ON public.invoices
  FOR SELECT
  TO authenticated
  USING (
    (SELECT auth.uid()) IS NOT NULL
    AND (SELECT auth.uid()) = user_id
    AND deleted_at IS NULL
  );

-- ── INSERT ────────────────────────────────────────────────────────────────────
-- El usuario solo puede insertar facturas para sí mismo.
-- WITH CHECK previene que manipule el user_id en el body.
CREATE POLICY "usuarios_insertan_sus_facturas"
  ON public.invoices
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
  );

-- ── UPDATE ────────────────────────────────────────────────────────────────────
-- El usuario puede actualizar (ej: cambiar status, agregar categoría)
-- pero no puede cambiar el user_id ni reactivar una factura eliminada.
CREATE POLICY "usuarios_actualizan_sus_facturas"
  ON public.invoices
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND deleted_at IS NULL
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
  );

-- ── DELETE ────────────────────────────────────────────────────────────────────
-- NO hay política DELETE para el rol 'authenticated'.
-- El cliente hace soft-delete (UPDATE deleted_at = now()).
-- La eliminación física solo ocurre desde Edge Functions con service_role.
-- Esto protege contra borrado accidental o malicioso desde el cliente.
