/**
 * Verificación de seguridad para el webhook de Gmail Pub/Sub.
 * Verifica que el JWT en Authorization provenga de Google y no haya expirado.
 */

const GOOGLE_CERTS_URL  = 'https://www.googleapis.com/oauth2/v3/certs'
const EXPECTED_AUDIENCE = Deno.env.get('GMAIL_WEBHOOK_AUDIENCE') ?? ''

interface JwtHeader  { kid: string; alg: string }
interface JwtPayload { aud: string; iss: string; exp: number }

export async function verifyGoogleJwt(token: string): Promise<boolean> {
  try {
    if (!token) return false

    const [headerB64, payloadB64, sigB64] = token.split('.')
    if (!headerB64 || !payloadB64 || !sigB64) return false

    const header  = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'))) as JwtHeader
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload

    if (payload.exp < Math.floor(Date.now() / 1000)) return false
    if (EXPECTED_AUDIENCE && payload.aud !== EXPECTED_AUDIENCE) return false
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) return false

    const certsRes = await fetch(GOOGLE_CERTS_URL)
    const certs    = await certsRes.json() as { keys: Array<{ kid: string } & JsonWebKey> }
    const jwk      = certs.keys.find(k => k.kid === header.kid)
    if (!jwk) return false

    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    )
    const sigBytes  = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`)

    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, dataBytes)
  } catch (e) {
    console.error('verifyGoogleJwt error:', e)
    return false
  }
}

export {}
