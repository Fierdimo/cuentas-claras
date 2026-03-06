/**
 * Edge Function: oauth-callback
 *
 * Actúa como puente HTTPS → custom scheme para el flujo OAuth de Gmail.
 *
 * Flujo:
 *  1. La app abre Google auth con redirect_uri = esta URL (HTTPS — Google la acepta)
 *  2. Google redirige aquí con ?code=...
 *  3. Esta función redirige a com.cuentas.app://oauth2redirect?code=...
 *  4. Android intercepta el custom scheme y devuelve el control a la app
 *
 * Desplegada con --no-verify-jwt porque Google no envía JWT de Supabase.
 */
Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const code  = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const state = url.searchParams.get('state')

  // Si Google devolvió un error (ej. usuario canceló)
  if (error) {
    const dest = new URL('com.cuentas.app://oauth2redirect')
    dest.searchParams.set('error', error)
    return Response.redirect(dest.toString(), 302)
  }

  if (!code) {
    return new Response('Missing code parameter', { status: 400 })
  }

  // Redirigir a la app con el code
  const dest = new URL('com.cuentas.app://oauth2redirect')
  dest.searchParams.set('code', code)
  if (state) dest.searchParams.set('state', state)

  return Response.redirect(dest.toString(), 302)
})
