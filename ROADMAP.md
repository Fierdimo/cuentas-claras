# Cuentas — App Móvil de Gestión Automática de Facturas
> Colombia · Fase 1 · React Native + Expo (EAS) + Supabase + TypeScript

---

## Decisiones de Arquitectura (no cambiar sin revisión)

| Decisión | Elección | Razón |
|---|---|---|
| Framework móvil | Expo + EAS Builds (NO Expo Go) | Módulos nativos desde el inicio |
| Backend / DB | Supabase (PostgreSQL + Vault + Edge Functions) | Relacional, RLS, Vault para tokens |
| Lenguaje | TypeScript estricto | Full-stack uniforme |
| Descompresión ZIP | `fflate` (puro JS) | Sin build nativo, cliente + Deno |
| Parseo XML | `fast-xml-parser` | Funciona en RN y Deno |
| Cache local | `expo-sqlite` + sync engine propio | Sin WatermelonDB overhead |
| Sesión en dispositivo | `expo-secure-store` | Keychain/Keystore, nunca AsyncStorage |
| OAuth móvil | `expo-auth-session` PKCE | Sin WebView, flujo nativo |
| Escáner QR | `react-native-vision-camera` | MLKit (Android) + VisionKit (iOS) |
| Patrón de extensión | Abstract Factory + Registry | Multi-país sin romper contrato |
| País activo Fase 1 | **Colombia únicamente** | DIAN · UBL 2.1 · CUFE |
| ZIP con contraseña | Alerta + `status:'locked'` | Implementación futura (`react-native-zip-archive`) |
| Formato de entrada | Solo ZIP | Único formato de proveedores DIAN certificados |
| Entidades de datos | **Facturas** y **Movimientos** son tablas y listas separadas | Diferente modelo, diferente propósito: DIAN vs. banco |
| Intercepción bancaria | Notificación propia + **confirmación explícita del usuario** | El usuario es el guardián — elimina duplicados automáticos |
| Fuente principal de movimientos | Email bancario (Nequi, Bancolombia, Davivienda…) | Más confiable que push/SMS, cubre offline y no requiere permiso especial |
| Rango de escaneo Gmail | **Incremental** — 90 días solo en primer sync, luego desde `backfill_completed_at` − 10 min | Minimiza cuota Gmail API y tiempo de carga en aperturas sucesivas |
| Correo IMAP | **App password** almacenada en Vault + sync disparado desde el cliente en momentos clave | Sin polling automático; mismo patrón que `backfill-gmail` — consume API solo cuando hay potencial de datos nuevos |
| Credenciales IMAP | Nunca en el dispositivo — solo en Vault (igual que refresh tokens) | Misma arquitectura de seguridad que OAuth; el cliente solo envía el password una vez |

---

## Fases del Proyecto

```
FASE 1 ── Infraestructura y núcleo          ✅ Completa
FASE 2 ── Pipeline de procesamiento         ✅ Completa
FASE 3 ── Correo electrónico (Gmail / Outlook)
          ├── 3.6 Parseo de correos bancarios      ✅
          ├── 3.7 Múltiples cuentas de correo      ✅
          └── 3.8 Correo IMAP (empresarial)        ⬜
FASE 4 ── Sincronización y seguridad        ✅ Completa
FASE 5 ── Flujos alternativos (QR / manual) 🔄 Parcial
FASE 6 ── Dashboard y UX                    🔄 Parcial
FASE 7 ── Compliance, pruebas y producción  ⬜ Pendiente
FASE 8 ── Movimientos bancarios             🔄 En progreso  ← AQUÍ
          ├── 8.1 Tabla pending_movements         ✅
          ├── 8.2 Detección por email bancario     ✅
          ├── 8.3 Confirmación/rechazo usuario     ✅
          ├── 8.4 Transferencias internas          ✅
          ├── 8.5 Movimientos manuales (FAB)       ✅
          ├── 8.6 Timeline unificado con facturas  ✅
          └── 8.7 Otras fuentes no detectadas      ⬜
                  (PSE, tiendas online, etc.)
```

---

## FASE 1 — Infraestructura y Núcleo

**Objetivo:** Proyecto corriendo en dispositivo físico con EAS, Supabase conectado, estructura de carpetas lista.

### 1.1 Scaffolding del proyecto Expo

- [x] `npx create-expo-app cuentas --template expo-template-blank-typescript`
- [x] Instalar EAS CLI: `npm install -g eas-cli`
- [x] Login EAS: `eas login`
- [x] Inicializar EAS: `eas init`  ← projectId: `23a91375-aecc-41c4-995d-e1c7cf6bf478`
- [x] Crear `eas.json` con perfiles `development`, `preview`, `production`
- [x] Configurar `app.json`: `bundleIdentifier` (iOS) y `package` (Android)

### 1.2 Instalación de dependencias

```bash
# Core
npx expo install expo-secure-store expo-sqlite expo-auth-session
npx expo install expo-document-picker expo-notifications

# Cámara / QR (nativo)
npx expo install react-native-vision-camera
# En android/gradle.properties agregar: VisionCamera_enableCodeScanner=true

# Supabase
npm install @supabase/supabase-js

# Procesamiento ZIP y XML
npm install fflate fast-xml-parser

# UI / Gráficos
npm install react-native-gifted-charts

# WebView (portal DIAN)
npx expo install react-native-webview
```

### 1.3 Estructura de carpetas

```
src/
├── invoice/
│   ├── types/
│   │   ├── canonical.ts          ← CanonicalInvoice (modelo universal)
│   │   └── email.ts              ← ParsedAttachment, EmailMessage
│   ├── detection/
│   │   └── countryDetector.ts    ← detectCountryFromXml()
│   ├── parsers/
│   │   ├── IInvoiceParser.ts     ← Interfaz contrato
│   │   └── colombia/
│   │       ├── ColombiaInvoiceParser.ts
│   │       └── colombia.test.ts
│   ├── pipeline/
│   │   └── attachmentPipeline.ts ← Descomprimir → extraer → detectar
│   └── InvoiceParserFactory.ts   ← Registry + entry point
│
├── supabase/
│   ├── client.ts                 ← createClient con SecureStore
│   ├── migrations/
│   │   ├── 001_invoices.sql
│   │   ├── 002_rls_policies.sql
│   │   ├── 003_oauth_tokens.sql
│   │   └── 004_audit_and_cron.sql
│   └── functions/
│       ├── process-invoice/
│       │   └── index.ts          ← Edge Function: Gmail webhook
│       ├── store-oauth-token/
│       │   └── index.ts          ← Edge Function: guardar token en Vault
│       └── _shared/
│           ├── cors.ts
│           └── verifyWebhook.ts  ← JWT Google + HMAC
│
├── sync/
│   ├── LocalInvoiceDatabase.ts   ← expo-sqlite wrapper
│   ├── SyncEngine.ts             ← Upload pending + download changes
│   └── conflictResolver.ts       ← Estrategias de resolución
│
├── hooks/
│   ├── useInvoices.ts
│   ├── useRealtimeSync.ts
│   └── useAuth.ts
│
├── screens/
│   ├── auth/
│   │   ├── LoginScreen.tsx
│   │   └── ConsentScreen.tsx     ← Autorización Ley 1581
│   ├── invoices/
│   │   ├── InvoiceListScreen.tsx
│   │   ├── InvoiceDetailScreen.tsx
│   │   └── QRScannerScreen.tsx
│   ├── connect/
│   │   └── ConnectEmailScreen.tsx
│   └── dashboard/
│       └── DashboardScreen.tsx
│
└── lib/
    ├── secureStorage.ts          ← Wrapper expo-secure-store para Supabase
    └── notifications.ts          ← Expo Notifications setup
```

### 1.4 Primer EAS Development Build

- [x] `eas build --profile development --platform android`
- [x] Instalar el `.apk` en el dispositivo físico
- [x] Verificar que Fast Refresh funciona con el development client

**Estado:** ✅ Fase 1 completa

---

## FASE 2 — Pipeline de Procesamiento (Núcleo)

**Objetivo:** Dado un archivo ZIP de factura DIAN, extraer el `CanonicalInvoice` correctamente. Verificable con tests unitarios sin necesidad de correo ni OAuth.

### 2.1 Tipos canónicos (`src/invoice/types/canonical.ts`)

Definir las interfaces TypeScript:
- `CanonicalInvoice` — modelo universal con campos: `id`, `countryCode`, `invoiceFormat`, `originalXmlHash`, `invoiceNumber`, `invoiceType`, `issueDate`, `issuer` (NIT, nombre, dirección), `recipient`, `currency`, `subtotal`, `totalTax`, `totalAmount`, `taxes[]`, `lineItems[]`, `authorizationCode` (CUFE), `status`, `userId`, `version`, `syncedAt`, `deletedAt`
- `CanonicalParty` — `taxId`, `taxIdType` (NIT/RFC/RUC/OTHER), `legalName`, `address`, `email`
- `CanonicalTaxLine` — `taxType`, `taxableAmount`, `taxRate`, `taxAmount`
- `CanonicalLineItem` — `lineNumber`, `description`, `quantity`, `unitPrice`, `lineTotal`, `taxes[]`

### 2.2 Detección de país (`src/invoice/detection/countryDetector.ts`)

- Escanear primeros 2KB del XML por firmas de namespace
- `dian.gov.co` → `'CO'`
- Retornar `{ countryCode, format, confidence }`

### 2.3 Interfaz `IInvoiceParser` (`src/invoice/parsers/IInvoiceParser.ts`)

```typescript
interface IInvoiceParser {
  countryCode: string
  supportedFormat: string
  parse(xml: string, meta: ParseMetadata): Promise<CanonicalInvoice>
  validate(invoice: CanonicalInvoice): ValidationResult
}
```

### 2.4 `ColombiaInvoiceParser`

Extraer con `fast-xml-parser` (modo `removeNSPrefix: false`):
- CUFE desde `cbc:UUID`
- Número de factura desde `cbc:ID`
- Fecha desde `cbc:IssueDate`
- NIT emisor desde `cac:AccountingSupplierParty`
- NIT receptor desde `cac:AccountingCustomerParty`
- Totales desde `cac:LegalMonetaryTotal`
- IVA desde `cac:TaxTotal[]`
- Líneas desde `cac:InvoiceLine[]`
- Validar: CUFE = 96 chars, NIT formato colombiano

### 2.5 Pipeline de adjuntos (`src/invoice/pipeline/attachmentPipeline.ts`)

```
Uint8Array (adjunto del correo)
  │
  ├── Magic bytes PK\x03\x04 → ZIP
  │     └── fflate.unzipSync()
  │           └── Buscar *.xml en el ZIP
  │                 └── Si es AttachedDocument UBL 2.1:
  │                       └── Base64-decode <cbc:Description> → XML interno
  │
  └── ZIP con contraseña → status: 'locked' + alerta
```

### 2.6 `InvoiceParserFactory`

- Registro en `Map<string, IInvoiceParser>`
- `registerAll()` registra `ColombiaInvoiceParser` (único en Fase 1)
- `parse(attachment, userId)` → detecta país → busca en registro → retorna `CanonicalInvoice`
- `UnsupportedCountryError` para países sin parser registrado

### 2.7 Tests unitarios

- Obtener 2–3 ZIPs de facturas DIAN reales de muestra
- Test: ZIP válido → `CanonicalInvoice` correcto
- Test: ZIP con múltiples XMLs → procesar todos
- Test: ZIP con contraseña → `status: 'locked'`
- Test: XML de país no registrado → `UnsupportedCountryError`

**Estado:** ✅ Fase 2 completa — parser, pipeline y tipos implementados. Tests con ZIPs reales validados en backfill (Colombia Telecomunicaciones, Éxito, etc.)

---

## FASE 3 — Correo Electrónico (Gmail / Outlook)

**Objetivo:** El usuario conecta su correo, la app escanea facturas existentes y nuevas llegan automáticamente via push.

### 3.1 Flujo OAuth en el dispositivo

- `expo-auth-session` con PKCE (sin WebView)
- Gmail scope: `https://www.googleapis.com/auth/gmail.readonly`
- Outlook scope: `Mail.Read` (Microsoft Graph)
- El cliente envía solo el `code` a la Edge Function `store-oauth-token`
- La Edge Function hace el exchange y guarda el refresh token en **Supabase Vault**
- El refresh token **nunca llega al dispositivo**

**Estado:** ✅ Completo

### 3.2 Edge Function `store-oauth-token`

- Recibe: `{ code, provider, userId, redirectUri }`
- Intercambia con Google/Microsoft → obtiene `refresh_token` + `access_token`
- Guarda en Vault: `vault.create_secret(refresh_token, name, description)`
- Guarda metadata en `private.oauth_tokens` (referencia al secret ID, no el token)
- Responde: `{ success: true, emailAddress }`

**Estado:** ✅ Completo

### 3.3 Edge Function `process-invoice` (Gmail webhook)

Seguridad en capas:
1. Verificar JWT de Google (JWKS público de Google)
2. Verificar HMAC secreto del webhook
3. Solo usar `service_role` — nunca expuesto al cliente

Pipeline interno:
1. Leer `historyId` del Pub/Sub message
2. Obtener refresh token del Vault
3. Obtener nuevo access token con el refresh token
4. Listar mensajes nuevos desde `historyId`
5. Para cada mensaje: buscar adjunto ZIP → pipeline de procesamiento
6. Guardar `CanonicalInvoice` en tabla `invoices`
7. Enviar push notification vía Expo Push API

**Estado:** ✅ Completo — infraestructura webhook funcional; `process-invoice` desplegado

### 3.4 Gmail Watch + Google Cloud Pub/Sub

- Crear topic en Google Cloud: `projects/{PROJECT}/topics/gmail-invoices`
- Dar permiso de publish a `gmail-api@system.gserviceaccount.com`
- Registrar watch: `POST /gmail/v1/users/me/watch` con `{ topicName, labelIds: ['INBOX'] }`
- Watch expira cada 7 días → renovar automáticamente con `pg_cron`

**Estado:** ⏸ Diferido — se implementa junto con notificaciones push (§6.4); el backfill incremental cubre el caso de uso actual completamente

### 3.5 Escaneo de correos (backfill incremental)

Estrategia de rango adaptativa según el estado de sincronización:

| Situación | Rango consultado | Razón |
|---|---|---|
| Primera vez (`backfill_completed_at = null`) | Últimos **90 días** | Escaneo histórico completo |
| App abierta con sync previo (> 5 min) | Desde `backfill_completed_at` − 10 min | Solo emails nuevos, mínimo consumo de cuota |
| App abierta con sync reciente (< 5 min) | No dispara | Cooldown para evitar llamadas redundantes |

**Implementación:**
- Query usa epoch timestamp (`after:1234567890`) para precisión exacta (no solo fecha)
- Buffer de 10 min en el límite inferior para capturar emails que llegaron justo antes del cierre del sync previo
- Duplicados eliminados automáticamente en upsert (`onConflict: 'id'` con CUFE como UUID)
- Paginación de 20 mensajes por llamada; `sinceDate` se pasa entre páginas para consistencia
- `backfill_completed_at` en `private.oauth_tokens` actúa como `last_synced_at` y se actualiza al terminar cada scan
- RPC `get_gmail_sync_info()` devuelve refresh token + `last_synced_at` en un solo viaje a la DB (migración `010`)
- Auto-trigger en `useConnectedAccounts` al montar el hook (cooldown de 5 min en cliente)

**Estado:** ✅ Completo — migración `010`, `backfill-gmail` actualizado y desplegado

### 3.6 Parseo de correos bancarios (Movimientos)

**Objetivo:** Detectar correos transaccionales de bancos colombianos y extraer movimientos pendientes de confirmación. Es la fuente **más confiable** porque:
- Funciona en iOS y Android sin permisos especiales
- Cubre casos donde la app bancaria no disparó notificación push
- Cubre casos donde el usuario no tenía conectividad al momento del movimiento

**Bancos / apps a cubrir (Fase 1):**

| Emisor | `from` del correo | Asunto típico |
|---|---|---|
| Nequi | `notificaciones@nequi.com.co` | `Transferencia exitosa` / `Recibiste dinero` |
| Bancolombia | `alertas@notificaciones.bancolombia.com.co` | `Transacción realizada` / `Abono en cuenta` |
| Davivienda | `alertas@davivienda.com` | `Notificación de movimiento` |
| Daviplata | `daviplata@daviplata.com` | `Transacción Daviplata` |

**Pipeline de detección:**
```
Email entrante (webhook Gmail)
  │
  ├── ¿Tiene adjunto ZIP? → pipeline de facturas DIAN (existente)
  │
  └── ¿Es de dominio bancario conocido?
        └── Extraer del body (HTML/texto):
              ├── Monto  (regex: \$[\d.,]+)
              ├── Dirección (crédito / débito)
              ├── Contraparte (de quién / hacia quién)
              ├── Cuenta (últimos 4 dígitos si aparece)
              └── Timestamp del correo
        └── Crear MovimientoPendiente con source: 'email'
        └── Enviar notificación push al usuario → Fase 8
```

**Nota:** Nunca se registra automáticamente. El movimiento queda en estado `pending_confirmation` hasta que el usuario aprueba.

**Estado:** ✅ Completo — `detect-bank-emails` desplegada; allowlist de 10 bancos; parsers conocidos (Nequi, Bancolombia, Davivienda, Daviplata); reglas aprendidas en DB (`bank_email_parsers`); fallback Perplexity que guarda reglas para reusar; `pending_movements` tabla con deduplicación por `gmail_msg_id`

### 3.7 Múltiples cuentas de correo por usuario

**Objetivo:** Un mismo usuario puede conectar varias cuentas de email — cualquier combinación de Gmail y Outlook — y todas se escanean de forma independiente.

**Modelo de datos** (ya soportado por `private.oauth_tokens`):
```
usuario ─── N cuentas OAuth
             ├── gmail  ·  grmoralesp@gmail.com
             ├── gmail  ·  grmoralesp@empresa.com      ← cuenta adicional
             └── outlook ·  grmoralesp@hotmail.com
```
- `private.oauth_tokens` ya permite múltiples filas por `user_id` (sin constraint único)
- `email_address` es la clave de presentación en la UI
- `provider` distingue `'gmail'` vs `'outlook'`

**Cambios necesarios:**

| Área | Descripción |
|---|---|
| `store-oauth-token` | Ya soporta múltiples tokens — cada `(user_id, provider, email_address)` genera una fila nueva |
| `backfill-gmail` | Recibe `email_address` como parámetro opcional para escanear solo esa cuenta |
| `backfill-outlook` | Nueva Edge Function similar a `backfill-gmail` pero para Microsoft Graph API |
| `process-invoice` | Recibir `historyId` + `emailAddress` del Pub/Sub message para identificar qué cuenta originó el evento |
| Gmail Watch | Crear un Watch independiente por cada cuenta Gmail conectada |
| `ConnectEmailScreen` | Mostrar lista de cuentas conectadas + botón "+ Agregar cuenta" para Gmail y Outlook |
| `SettingsScreen` | Permitir desconectar cuentas individualmente (revocar token + eliminar fila + cancelar Watch) |

**Flujo "Agregar cuenta":**
```
ConnectEmailScreen
  └── "+  Agregar Gmail"  |  "+ Agregar Outlook"
        │
        ▼
  OAuth PKCE (expo-auth-session)
  └── code → store-oauth-token (provider + userId + emailAddress)
        └── Vault.create_secret  →  nueva fila en oauth_tokens
        └── Registrar Gmail Watch para esta cuenta
        └── Lanzar backfill-gmail para esta cuenta (90 días)
        └── UI actualiza lista de cuentas conectadas
```

**Flujo "Desconectar cuenta":**
```
SettingsScreen > cuenta conectada > "Desconectar"
  └── Revocar token en Google/Microsoft
  └── Eliminar Watch (Gmail) o suscripción (Outlook)
  └── Marcar `is_active = false` en oauth_tokens
  └── Vault.delete_secret
  └── UI actualiza lista (cuenta desaparece)
```

**Consideraciones técnicas:**
- OAuth de Google permite conectar varias cuentas con el mismo `client_id` — cada autorización retorna un `refresh_token` distinto
- La pantalla de consentimiento de Google muestra cuál cuenta se está autorizando — no hay ambigüedad
- Las facturas se guardan con `source_email` para trazar de qué cuenta vinieron
- Si la misma factura llega por dos cuentas distintas: `onConflict: 'id'` (CUFE como UUID) evita duplicados automáticamente

**Estado:** ✅ Completo — migración `011`, `backfill-gmail` actualizado, `useConnectedAccounts` y `ConnectEmailScreen` refactorizados

---

### 3.8 Correo IMAP (empresarial / privado)

**Objetivo:** Soportar cualquier servidor de correo que hable IMAP (Exchange corporativo, Zoho, Fastmail, Yahoo Mail, correo propio, etc.) sin depender de OAuth de Google o Microsoft.

**Por qué IMAP y no OAuth para estos proveedores:**
- La mayoría de servidores empresariales no exponen OAuth2 en sus propios dominios
- IMAP sobre TLS (puerto 993) es el estándar universal soportado por cualquier servidor
- Los proveedores que sí tienen OAuth (Yahoo, iCloud, Fastmail) también soportan IMAP con **app password**, que es más simple de implementar

**Lo que NO aplica:**
- ProtonMail: requiere el Bridge local instalado en el PC — fuera de alcance
- Correos con 2FA obligatorio sin app passwords: el usuario debe generar un app password en su proveedor

**Diferencias clave vs Gmail/Outlook OAuth:**

| Aspecto | Gmail / Outlook | IMAP generico |
|---|---|---|
| Auth | OAuth2 PKCE (refresh token) | App password en Vault |
| Disparo de sync | Gmail Watch (Pub/Sub push) | **Event-driven desde el cliente** (mismo patrón que `backfill-gmail`) |
| Momentos de sync | Tiempo real (push automático) | Apertura de app · botón manual · al conectar cuenta |
| Credencial a guardar | Refresh token (en Vault) | App password (en Vault) |
| UI de conexión | Botón OAuth (browser) | Formulario: servidor, puerto, usuario, app password |

**Modelo de datos** — misma tabla `private.oauth_tokens`, nuevo `provider`:
```sql
-- provider = 'imap' (nuevo valor al lado de 'gmail' y 'outlook')
-- email_address = la dirección del usuario
-- refresh_token_secret_id apunta al Vault donde está el app password
-- Nueva columna necesaria (migración 012):
ALTER TABLE private.oauth_tokens
  ADD COLUMN IF NOT EXISTS imap_host TEXT,    -- mail.empresa.com
  ADD COLUMN IF NOT EXISTS imap_port INTEGER DEFAULT 993;
```

**Flujo de conexión:**
```
ConnectEmailScreen → "+  Agregar IMAP"
  └── FormularioIMAP: host, puerto (993), usuario, app password
        └── store-imap-credentials (nueva Edge Function)
              └── Validar conexión (IMAP CAPABILITY + LOGIN de prueba)
              └── App password → Vault.create_secret
              └── Guardar metadata en oauth_tokens (provider='imap', host, port)
              └── Lanzar backfill-imap (90 días inicial)
              └── Responde: { success, emailAddress }
```

**Sync event-driven (sin polling automático):**

IMAP no tiene webhooks ni push nativo, pero el cron automático tiene un costo alto: procesamiento garantizado, resultados probables de cero. En cambio, se adopta el mismo patrón que `backfill-gmail`:

| Momento | Acción |
|---|---|
| **App se abre** (hook mount) | `runBackfill('imap', email)` si han pasado > 5 min desde último sync |
| **Botón “Escanear correos”** | `runBackfill('imap', email)` inmediato, sin cooldown |
| **Al conectar la cuenta** | Escaneo inicial de 90 días |
| **App en background** | Sin actividad — IMAP no corre en background |

Ventajas vs polling:
- Cero peticiones en momentos en los que el usuario no usa la app
- El usuario tiene control total y feedback inmediato
- Sin costo de Supabase Edge Function en idle
- `backfill_completed_at` ya existe en `oauth_tokens` — sirve como `last_synced_at` para IMAP sin cambios de esquema adicionales

**Nuevas Edge Functions necesarias:**

| Función | Descripción |
|---|---|
| `store-imap-credentials` | Recibe host/port/user/password, valida conexión IMAP, guarda en Vault |
| `sync-imap` | Escaneo inicial (90 días) o incremental — misma firma que `backfill-gmail` (`userId`, `emailAddress`, `pageToken?`, `sinceDate?`); disparado desde el cliente en momentos clave |

**Implementación IMAP en Deno:**
- Deno soporta `Deno.connectTls()` nativo para conexiones IMAP sobre TLS
- Biblioteca: [`imapflow`](https://imapflow.com/) via `npm:imapflow` (Deno NPM compat) o implementación minimal del protocolo
- Comando IMAP clave: `SEARCH SINCE DD-Mon-YYYY` para escaneo incremental (equivalente al `after:` de Gmail)
- Archivos a buscar: adjuntos con extensión `.zip` (igual que en Gmail)

**UI — `ConnectEmailScreen`:**
- Nuevo botón “+ Agregar IMAP / empresarial” que abre un `Modal` con el formulario
- Campos: servidor IMAP, puerto (default 993), correo, app password
- Enseñar enlace de ayuda por proveedor popular (Gmail, Yahoo, iCloud, Outlook.com) apuntando a la página oficial de app passwords
- Las tarjetas de cuentas IMAP muestran el host en lugar del proveedor: `✉️ usuario@empresa.com · mail.empresa.com`

**Estado:** ⬜ Pendiente

---

**Estado:** 🔄 Parcial  
- ✅ OAuth PKCE — Gmail y Outlook (`store-oauth-token` + Vault)  
- ✅ `process-invoice` — infraestructura webhook funcional  
- ⏸ Gmail Watch / Pub/Sub — diferido a §6.4 (notificaciones push); backfill incremental cubre el caso de uso actual  
- ✅ Backfill incremental — migración `010`, `backfill-gmail` desplegado  
- ✅ Multi-cuenta — migración `011`, `ConnectEmailScreen` y `useConnectedAccounts` actualizados  
- ✅ Parseo de correos bancarios — `detect-bank-emails` + allowlist + Perplexity fallback + reglas aprendidas en DB  
- ⏸ Soporte Outlook (`backfill-outlook` pendiente) — requiere cuenta Azure AD  
- ⬜ IMAP (`store-imap-credentials` + `sync-imap` pendientes)  

## FASE 4 — Sincronización y Seguridad

**Objetivo:** Datos disponibles offline, sincronizados entre dispositivos, protegidos correctamente.

### 4.1 Migraciones Supabase

**`001_invoices.sql`**
```sql
CREATE TABLE invoices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  country_code   TEXT NOT NULL DEFAULT 'CO',
  invoice_data   JSONB NOT NULL,        -- CanonicalInvoice completo
  invoice_number TEXT NOT NULL,
  issuer_tax_id  TEXT,
  issuer_name    TEXT,
  total_amount   NUMERIC(15,2),
  currency       TEXT DEFAULT 'COP',
  issue_date     DATE,
  status         TEXT DEFAULT 'pending',  -- pending|approved|rejected|locked|cancelled
  source         TEXT DEFAULT 'email',    -- email|qr|manual
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  version        INTEGER DEFAULT 1
);
CREATE INDEX idx_invoices_user    ON invoices(user_id, issue_date DESC);
CREATE INDEX idx_invoices_status  ON invoices(user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_invoices_issuer  ON invoices(user_id, issuer_tax_id);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER PUBLICATION supabase_realtime ADD TABLE invoices;
```

**`002_rls_policies.sql`**
- SELECT: `(select auth.uid()) = user_id AND deleted_at IS NULL`
- INSERT: `WITH CHECK ((select auth.uid()) = user_id)`
- UPDATE: `USING + WITH CHECK` ambos con `user_id`
- Sin política DELETE para `authenticated` — solo soft-delete desde cliente

**`003_oauth_tokens.sql`**
```sql
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE private.oauth_tokens (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL,   -- 'gmail' | 'outlook'
  email_address           TEXT NOT NULL,
  refresh_token_secret_id UUID,            -- FK a vault.secrets
  token_scope             TEXT[],
  is_active               BOOLEAN DEFAULT TRUE,
  last_refreshed          TIMESTAMPTZ DEFAULT now(),
  created_at              TIMESTAMPTZ DEFAULT now()
);
REVOKE ALL ON private.oauth_tokens FROM anon, authenticated;
GRANT ALL ON private.oauth_tokens TO service_role;
```

**`004_audit_and_cron.sql`**
```sql
-- Audit log append-only
CREATE TABLE private.audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES auth.users(id),
  action        TEXT NOT NULL,   -- VIEW|EXPORT|DELETE|GDPR_ERASURE|OAUTH_CONNECTED
  resource_id   UUID,
  metadata      JSONB,
  performed_at  TIMESTAMPTZ DEFAULT now(),
  performed_by  TEXT DEFAULT 'user'
);
REVOKE ALL ON private.audit_log FROM anon, authenticated;
GRANT ALL ON private.audit_log TO service_role;

-- Purga GDPR a 90 días
SELECT cron.schedule(
  'gdpr-purge-deleted',
  '0 3 * * 0',
  $$ DELETE FROM public.invoices
     WHERE deleted_at IS NOT NULL
     AND deleted_at < NOW() - INTERVAL '90 days'; $$
);

-- Renovar Gmail Watch cada 6 días
SELECT cron.schedule(
  'renew-gmail-watch',
  '0 6 */6 * *',
  $$ SELECT net.http_post(url := current_setting('app.edge_fn_url') || '/renew-gmail-watch',
     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
     body := '{}'::jsonb); $$
);
```

### 4.2 Cliente Supabase en la app (`src/supabase/client.ts`)

```typescript
import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'

const storage = {
  getItem:    (key: string) => SecureStore.getItemAsync(key),
  setItem:    (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
}

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,   // ← anon key, NUNCA service_role
  { auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } }
)
```

### 4.3 `LocalInvoiceDatabase` (`src/sync/LocalInvoiceDatabase.ts`)

- `init()` — crea tabla SQLite con WAL mode
- `upsertInvoice(invoice, syncStatus)` — INSERT OR REPLACE
- `getPendingUploads()` — `WHERE sync_status = 'pending_upload'`
- `getAll(userId)` — `ORDER BY issue_date DESC WHERE deleted_at IS NULL`
- `markConflict(id)` — `sync_status = 'conflict'`

### 4.4 `SyncEngine` (`src/sync/SyncEngine.ts`)

- `sync()` — verifica conectividad → upload pending → download changes
- `uploadPending()` — upsert a Supabase → marcar `synced`
- `downloadChanges()` — query `updated_at > lastSyncedAt` → upsert local
- `conflictResolver.ts` — `server_wins` para datos parseados, `merge` para anotaciones

### 4.5 Hook `useRealtimeSync`

- Canal Supabase Realtime filtrado por `user_id=eq.{userId}`
- `INSERT/UPDATE` → `localDb.upsertInvoice()`
- `DELETE` → soft-delete local
- Reconexión automática → trigger full re-fetch

**Estado:** ✅ Fase 4 completa  
- Migraciones 001–013 aplicadas en producción  
- `LocalInvoiceDatabase` (expo-sqlite, WAL mode, sync_status)  
- `SyncEngine` (upload pending + download incremental)  
- `useRealtimeSync` (Realtime → SQLite → DeviceEventEmitter → UI)

---

## FASE 5 — Flujos Alternativos de Entrada

**Objetivo:** El usuario puede ingresar facturas sin depender del correo electrónico.

### 5.1 Importación manual de ZIP

- `expo-document-picker` → seleccionar ZIP desde almacenamiento
- Leer archivo como `Uint8Array`
- Pasar por el mismo pipeline del paso 2.5
- Guardar con `source: 'manual'`

**Estado:** ⬜ Pendiente

### 5.2 Escáner QR DIAN

- `react-native-vision-camera` + `useCodeScanner({ codeTypes: ['qr'] })`
- Validar que la URL sea `catalogo-vpfe.dian.gov.co/document/searchqr?documentkey={CUFE}`
- Extraer CUFE del parámetro `documentkey`
- Mostrar `WebView` con la URL DIAN (visualización oficial)
- Guardar registro con `source: 'qr'`, `authorizationCode: cufe`, `status: 'pending'`
- Permitir al usuario completar campos adicionales manualmente

**Estado:** 🔄 Parcial — `QRScannerScreen` stub implementado; validación CUFE y conexión con pipeline real pendientes

### 5.3 ZIP con contraseña (stub)

- Detectar error de `fflate` por contraseña
- Guardar con `status: 'locked'`
- Mostrar alerta: "Esta factura está protegida con contraseña"
- UI de desbloqueo: pendiente para iteración futura
- Arquitectura preparada: `react-native-zip-archive` ya en el build nativo

**Estado:** 🔄 Parcial
- ✅ `QRScannerScreen` stub implementado  
- ⬜ Importación manual de ZIP (`expo-document-picker`)  
- ⬜ Pipeline QR DIAN completamente conectado  

---

## FASE 6 — Dashboard y UX

**Objetivo:** Interfaz completa, funcional y usable.

### 6.1 Pantallas

| Pantalla | Descripción |
|---|---|
| `LoginScreen` | Login con Google/Microsoft vía Supabase Auth |
| `ConsentScreen` | Autorización explícita Ley 1581 — bloquea el flujo si no acepta |
| `ConnectEmailScreen` | Lista de cuentas conectadas (Gmail / Outlook) + botón "+ Agregar cuenta" + opción de desconectar |
| `InvoiceListScreen` | Lista con filtros (fecha, proveedor, estado, monto), búsqueda |
| `InvoiceDetailScreen` | CUFE, emisor, receptor, ítems, impuestos, acciones (aprobar/rechazar) |
| `QRScannerScreen` | Cámara full-screen + overlay de guía + resultado |
| `DashboardScreen` | Gráficos: gasto por mes, top proveedores, por categoría |
| `SettingsScreen` | Cuentas de correo conectadas, eliminar cuenta, política de privacidad |

**Estado:** 🔄 Parcial — Login, Dashboard, ConnectEmail, InvoiceList, InvoiceDetail, QRScanner implementadas; ConsentScreen y SettingsScreen pendientes

### 6.2 Gráficos (`react-native-gifted-charts`)

- Barras: gasto mensual (últimos 12 meses)
- Torta: distribución por categoría
- Lista: top 10 proveedores por monto total

**Estado:** ⬜ Pendiente

### 6.3 Exportación CSV

- Generar CSV en memoria con facturas filtradas
- Compartir vía `expo-sharing` (Share sheet nativo)

**Estado:** ⬜ Pendiente

### 6.4 Notificaciones push

- "Nueva factura recibida de [Proveedor] por $[Monto]"
- Tap en notificación → navegar a `InvoiceDetailScreen`

**Estado:** 🔄 Parcial  
- ✅ Pantallas base implementadas: Login, Dashboard, ConnectEmail, InvoiceList, InvoiceDetail, QRScanner  
- ⬜ Gráficos (gifted-charts): gasto mensual, top proveedores  
- ⬜ Exportación CSV  
- ⬜ Notificaciones push reales (Firebase)  
- ⬜ Filtros y búsqueda en InvoiceList  
- ⬜ SettingsScreen (cuentas conectadas, eliminar cuenta)

---

## FASE 7 — Compliance, Pruebas y Producción

**Objetivo:** App lista para publicación en stores y cumplimiento legal.

### 7.1 Compliance Ley 1581 de 2012

- [ ] Redactar y publicar **Política de Privacidad** en URL pública
- [ ] Pantalla de consentimiento en onboarding con checkbox explícito
- [ ] Botón "Eliminar mi cuenta" en Settings → soft-delete + purga 90 días
- [ ] Registrar como responsable del tratamiento de datos ante SIC
- [ ] Verificar región de hosting Supabase (debe ofrecer nivel de protección adecuado)

### 7.2 Verificación OAuth de Google

- [ ] Publicar política de privacidad (requerida por Google)
- [ ] Grabar video demo del flujo de uso del scope `gmail.readonly`
- [ ] Redactar justificación del uso limitado de datos
- [ ] Enviar solicitud de verificación en Google Cloud Console
- [ ] **Iniciar este proceso en paralelo con el desarrollo** — puede tardar 2–6 semanas

### 7.3 Pruebas

- [ ] Tests unitarios: `ColombiaInvoiceParser` con ZIPs de muestra reales
- [ ] Tests de integración: pipeline completo ZIP → Supabase
- [ ] Tests de RLS: verificar que usuario A no puede ver facturas de usuario B
- [ ] Tests de Edge Functions con Supabase CLI (`supabase functions serve`)
- [ ] Pruebas en dispositivo físico Android + iOS

### 7.4 EAS Production Build y Stores

- [ ] `eas build --profile production --platform android`
- [ ] `eas build --profile production --platform ios`
- [ ] `eas submit --platform android` → Google Play
- [ ] `eas submit --platform ios` → App Store

**Estado:** ⬜ Pendiente

---

## FASE 8 — Movimientos Bancarios

**Objetivo:** Registrar transferencias entrantes y salientes como una entidad separada de las facturas DIAN. El usuario es siempre el punto de aprobación — nunca hay registro automático.

### 8.1 Modelo de datos (`005_transactions.sql`)

```sql
CREATE TABLE public.transactions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Datos del movimiento
  amount           NUMERIC(15, 2) NOT NULL,
  currency         TEXT        NOT NULL DEFAULT 'COP',
  direction        TEXT        NOT NULL CHECK (direction IN ('credit', 'debit')),
  counterpart_name TEXT,                    -- "Juan Pérez" / "Supermercado XYZ"
  account_last4    TEXT,                    -- Últimos 4 dígitos de la cuenta
  description      TEXT,                    -- Texto original de la notificación/email
  bank_ref         TEXT,                    -- Referencia del banco si aparece
  -- Fuente y estado
  source           TEXT        NOT NULL
                   CHECK (source IN ('email', 'push_notification', 'sms', 'manual')),
  status           TEXT        NOT NULL DEFAULT 'pending_confirmation'
                   CHECK (status IN ('pending_confirmation', 'confirmed', 'rejected', 'duplicate')),
  -- Evidencias (todas las fuentes que reportaron este movimiento)
  evidence         JSONB       NOT NULL DEFAULT '[]',
  -- Fechas
  transacted_at    TIMESTAMPTZ,             -- Fecha/hora del movimiento según la fuente
  confirmed_at     TIMESTAMPTZ,             -- Cuando el usuario aprobó
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  version          INTEGER     NOT NULL DEFAULT 1
);

CREATE INDEX idx_transactions_user_date
  ON public.transactions (user_id, transacted_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_transactions_pending
  ON public.transactions (user_id, status)
  WHERE status = 'pending_confirmation' AND deleted_at IS NULL;

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
```

### 8.2 Flujo de confirmación (el usuario es el guardián)

```
[Fuente detecta movimiento: email / push / SMS]
        │
        ▼
  Crear registro con status: 'pending_confirmation'
  Guardar evidence[] con fuente, raw text y timestamp
        │
        ▼
  Enviar notificación push propia:
  ┌─────────────────────────────────────────────┐
  │ 💸 Movimiento detectado                      │
  │ Recibiste $50.000 de Juan Pérez (Nequi)      │
  │ Fuente: correo 14:32 · ¿Registrar?           │
  │                                              │
  │  [✅ Confirmar]        [❌ Ignorar]           │
  └─────────────────────────────────────────────┘
        │
   ┌────┴────┐
   ▼         ▼
Confirmar  Ignorar
status:    status:
'confirmed' 'rejected'
```

**Ventajas de este enfoque:**
- Cero duplicados: si llegan email + push + SMS del mismo movimiento, el usuario solo ve UNA notificación (el segundo y tercer aviso solo agregan su `evidence` al registro ya existente)
- El usuario tiene contexto para decidir si ya lo registró manualmente
- Queda trazabilidad completa de qué fuentes reportaron el evento

### 8.3 Deduplicación entre fuentes múltiples

Cuando llega una segunda fuente para el mismo movimiento (ej: ya existe un registro `pending_confirmation` por email y llega el push del banco):

```typescript
// Criterios de match (sin hash, lookup directo):
// - Mismo user_id
// - Mismo amount y direction
// - transacted_at dentro de una ventana de ±10 minutos
// - status IN ('pending_confirmation', 'confirmed')

if (existingTransaction) {
  // Solo agregar la nueva fuente al evidence[]
  // NO crear un nuevo registro
  // NO disparar otra notificación al usuario
  await appendEvidence(existingTransaction.id, newEvidence)
} else {
  // Primera vez que se detecta → crear y notificar
  await createPendingTransaction(data)
  await sendConfirmationPush(data)
}
```

### 8.4 Pantallas

| Pantalla | Descripción |
|---|---|
| `TransactionListScreen` | Lista separada de movimientos confirmados (créditos/débitos) con filtros |
| `PendingTransactionsScreen` | Bandeja de movimientos `pending_confirmation` esperando aprobación |
| `TransactionDetailScreen` | Detalle: monto, contraparte, evidencias, fecha, estado |

### 8.5 Parsers de email bancario

**Estado:** ✅ Implementado — `detect-bank-emails` Edge Function desplegada con:
- Allowlist de 10 bancos/apps colombianas (Nequi, Bancolombia, Davivienda, Daviplata, BBVA, Colpatria, AV Villas, Scotiabank, Itaú, Falabella)
- Parsers conocidos para los 4 emisores principales
- Fallback Perplexity AI para formatos desconocidos + aprendizaje en `bank_email_parsers`
- Tabla `pending_movements` con deduplicación por `gmail_msg_id`
- `BankMovementsScreen` con confirmación/rechazo, filtros, búsqueda, selector de mes y resumen de totales

### 8.6 Timeline unificado con facturas

**Estado:** ✅ Implementado
- `useFinancialTimeline` — hook maestro que cruza movimientos e invoices
- Ventana de detección de duplicados: 15 días (cross-month)
- Confianza graduada: `probable` (nombre + ≤5 días) / `possible` (nombre 6-15 días ó sin nombre ≤3 días)
- `possibleMatches`: movimiento → facturas candidatas
- `invoiceToMovementMatches`: factura → movimientos candidatos (mapa inverso)
- Facturas huérfanas sugieren movimiento vinculable; movimientos sugieren factura vinculable
- Migración `019`: `linked_invoice_id` en `pending_movements` + `linked_movement_id` en `invoices`

### 8.7 Movimientos manuales (cash / fuentes no detectables)

**Estado:** ✅ Implementado
- FAB `+` en `BankMovementsScreen` abre formulario bottom sheet
- Campos: dirección (crédito/débito), monto, descripción, fuente (chip selector), fecha (±días)
- Fuentes disponibles: Efectivo · Nequi · Bancolombia · Davivienda · Daviplata · BBVA · Otro
- `gmail_msg_id = null` como identificador de movimiento manual (sin columna extra)
- `createManual` / `deleteManual` en `usePendingMovements`
- Migración `020`: columna `source TEXT DEFAULT 'email'` en `pending_movements`
- RLS: el usuario debe agregar políticas INSERT + DELETE en Supabase (ver notas abajo)

### 8.8 Fuentes de movimientos aún no detectadas automáticamente ⚠️

Existe un conjunto de transacciones frecuentes que **no llegan por correo bancario** y por tanto no son capturadas automáticamente por el pipeline actual. Deben ingresarse de forma manual hasta que se implemente detección específica para cada fuente:

| Tipo | Ejemplos | Dificultad de detección | Posible fuente futura |
|---|---|---|---|
| **Pagos PSE** | Servicios públicos (EPM, Codensa, Gas Natural), impuestos DIAN/municipio, seguros | Media | Email de confirmación del banco + email del proveedor |
| **Tiendas online** | Mercado Libre, Falabella.com, Shein, Amazon, Rappi, iFood | Media | Email de confirmación de compra (remitente del marketplace) |
| **Suscripciones digitales** | Netflix, Spotify, Adobe, Google Play, Apple | Baja | Email de recibo/factura del servicio |
| **Pagos con tarjeta en POS físico** | Supermercados, restaurantes, gasolineras | Alta | No hay email; requeriría integración con extracto bancario o captura manual |
| **Retiros y depósitos ATM** | Cajeros automáticos | Alta | No hay email; requeriría integración con extracto bancario |
| **Pagos QR Nequi / Bancolombia A la mano** | Comercios con código QR | Media | Nequi ya envía correo; Bancolombia a veces envía alerta |
| **Giros nacionales** | Efecty, Baloto, Giro Bancolombia | Baja | Email de confirmación del operador |
| **Recargas de celular** | Tigo, Claro, Movistar | Baja | Email de confirmación del operador |

**Estrategia recomendada para cobertura incremental:**

1. **Corto plazo:** El usuario puede registrar cualquiera de estos manualmente con el FAB `+` ya implementado, eligiendo la fuente "Otro".
2. **Mediano plazo:** Agregar parsers para emails de confirmación de tiendas online frecuentes (Mercado Libre, Rappi, Netflix) — siempre envían email con monto y descripción claros.
3. **Largo plazo:** Integración con extracto bancario en PDF (Bancolombia, Davivienda) para capturar pagos en POS y ATM que nunca generan email; requiere OCR o parser estructurado del PDF.

**Pendiente de implementar:**
- [ ] Parsers de email para pagos PSE (el banco notifica en el mismo formato que una transacción normal)
- [ ] Parsers de email para Mercado Libre (`no-reply@mercadolibre.com.co`)
- [ ] Parsers de email para Rappi (`noreply@rappi.com`)
- [ ] Parsers de email para suscripciones (Netflix, Spotify → factura mensual)
- [ ] Importación de extracto bancario PDF → movimientos (OCR / parser estructurado)
- [ ] En formulario manual: ampliar lista de fuentes con PSE, Mercado Libre, Rappi, etc.

---

## Estado General

| Fase | Descripción | Estado |
|---|---|---|
| Fase 1 | Infraestructura y scaffolding | ✅ Completa |
| Fase 2 | Pipeline de procesamiento (núcleo) | ✅ Completa |
| Fase 3 | Correo electrónico (Gmail / Outlook / IMAP) | 🔄 Parcial (OAuth + backfill ✅ · multi-cuenta ✅ · bancario ✅ · renew-watch ⬜ · Pub/Sub ⬜ · IMAP ⬜) |
| Fase 4 | Sincronización y seguridad | ✅ Completa |
| Fase 5 | Flujos alternativos (QR / manual) | 🔄 Parcial (stub ✅ · pipeline ⬜) |
| Fase 6 | Dashboard y UX | 🔄 Parcial (pantallas ✅ · gráficos ⬜) |
| Fase 7 | Compliance, pruebas y producción | ⬜ Pendiente |
| Fase 8 | Movimientos bancarios | 🔄 En progreso (detección email ✅ · confirmación ✅ · transferencias ✅ · manuales ✅ · timeline unificado ✅ · PSE/online/POS ⬜) |

> **Nota Fase 8:** Existe una brecha conocida de movimientos no detectables automáticamente (PSE, tiendas online, POS físico, ATM). Ver §8.8 para el inventario completo y la estrategia de cobertura incremental.

---

## Variables de Entorno Requeridas

```bash
# .env (app móvil — solo vars EXPO_PUBLIC_* van al bundle)
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=          # Publicable, RLS activo

# Supabase Edge Functions secrets (nunca en el bundle)
SUPABASE_SERVICE_ROLE_KEY=              # Solo en Edge Functions
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=                    # Solo en Edge Functions
OUTLOOK_CLIENT_ID=
OUTLOOK_CLIENT_SECRET=                  # Solo en Edge Functions
GMAIL_WEBHOOK_SECRET=                   # HMAC para validar webhooks
GMAIL_PUBSUB_SERVICE_ACCOUNT=           # Email de la cuenta de servicio Google
GMAIL_WEBHOOK_AUDIENCE=                 # URL del Edge Function

# IMAP genérico (correo empresarial / privado)
# Las credenciales NO van aquí — se guardan en Vault desde store-imap-credentials
# Solo se necesitan en Edge Functions que accedan al Vault
# (reutilizan SUPABASE_SERVICE_ROLE_KEY ya definido arriba)
```

---

## Contexto Técnico del Formato DIAN (Referencia rápida)

```
Email con factura DIAN
  └── adjunto: FV-0001234.zip
        ├── AD_XXXXXXXXX.xml   ← AttachedDocument (UBL 2.1 wrapper)
        │     └── <cbc:UUID>   ← CUFE (96 chars SHA-384)
        │     └── <cac:Attachment>
        │           └── <cbc:Description>   ← BASE64 del XML interno
        │                 └── [decode] → fe:Invoice (XML real)
        │                       ├── cbc:ID             ← Número factura
        │                       ├── cbc:IssueDate      ← Fecha
        │                       ├── cac:AccountingSupplierParty → NIT emisor
        │                       ├── cac:AccountingCustomerParty → NIT receptor
        │                       ├── cac:LegalMonetaryTotal → Totales
        │                       ├── cac:TaxTotal[]     → IVA desglosado
        │                       └── cac:InvoiceLine[]  → Ítems
        └── FV-0001234.pdf     ← Representación gráfica (no binding)
                                  └── QR → https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey={CUFE}
```
