import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import type { Database } from './database.types'

/**
 * Storage adapter que usa Keychain (iOS) / Keystore (Android) a través de
 * expo-secure-store. Reemplaza el AsyncStorage predeterminado de Supabase.
 * Nunca almacena el JWT de sesión en texto plano.
 */
const secureStorage = {
  getItem: (key: string): Promise<string | null> =>
    SecureStore.getItemAsync(key),
  setItem: (key: string, value: string): Promise<void> =>
    SecureStore.setItemAsync(key, value),
  removeItem: (key: string): Promise<void> =>
    SecureStore.deleteItemAsync(key),
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Faltan variables de entorno: EXPO_PUBLIC_SUPABASE_URL y EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
    'Copia .env.example a .env y completa los valores.'
  )
}

/**
 * Cliente Supabase para uso en la app móvil.
 *
 * Usa la anon key (publicable) — RLS está activo en todas las tablas.
 * NUNCA usar la service_role key en el cliente.
 */
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})
