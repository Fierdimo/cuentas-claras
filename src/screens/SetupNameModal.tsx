import React, { useState } from 'react'
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from 'react-native'

interface Props {
  visible:  boolean
  onSave:   (name: string) => void
  onSkip:   () => void
}

/**
 * Aparece una sola vez tras el primer login cuando no hay nombre disponible
 * en el perfil OAuth (caso email/password). El nombre se guarda en
 * user_own_counterparts para detectar transferencias internas propias.
 */
export default function SetupNameModal({ visible, onSave, onSkip }: Props): React.JSX.Element {
  const [name, setName] = useState('')

  const handleSave = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave(trimmed)
    setName('')
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onSkip}>
      <Pressable style={styles.backdrop} onPress={onSkip} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.sheetWrapper}
      >
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <Text style={styles.emoji}>👤</Text>
          <Text style={styles.title}>¿Cómo te llamas?</Text>
          <Text style={styles.body}>
            Tu nombre nos ayuda a detectar automáticamente las transferencias entre
            tus propias cuentas bancarias, para no contarlas doble en tus totales.
          </Text>

          <TextInput
            style={styles.input}
            placeholder="Ej. Carlos Gómez"
            placeholderTextColor="#9ca3af"
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleSave}
          />

          <TouchableOpacity
            style={[styles.btnPrimary, !name.trim() && styles.btnDisabled]}
            onPress={handleSave}
            disabled={!name.trim()}
          >
            <Text style={styles.btnPrimaryText}>Guardar y continuar</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.btnSkip} onPress={onSkip}>
            <Text style={styles.btnSkipText}>Omitir por ahora</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop:      { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheetWrapper:  { flex: 1, justifyContent: 'flex-end' },
  sheet:         { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, paddingBottom: 40, alignItems: 'center' },
  handle:        { width: 40, height: 4, borderRadius: 2, backgroundColor: '#e5e7eb', marginBottom: 24 },
  emoji:         { fontSize: 40, marginBottom: 12 },
  title:         { fontSize: 20, fontWeight: '700', color: '#111827', marginBottom: 10, textAlign: 'center' },
  body:          { fontSize: 14, color: '#6b7280', textAlign: 'center', lineHeight: 21, marginBottom: 24 },
  input:         { width: '100%', borderWidth: 1, borderColor: '#d1d5db', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: '#111827', marginBottom: 14, backgroundColor: '#f9fafb' },
  btnPrimary:    { width: '100%', backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginBottom: 10 },
  btnDisabled:   { backgroundColor: '#93c5fd' },
  btnPrimaryText:{ color: '#fff', fontSize: 16, fontWeight: '700' },
  btnSkip:       { paddingVertical: 10 },
  btnSkipText:   { color: '#9ca3af', fontSize: 14 },
})
