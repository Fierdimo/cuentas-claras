import React from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'

interface Props {
  onClose: () => void
}

/**
 * Pantalla de escáner QR.
 * Fase 5: Implementar react-native-vision-camera con MLKit/VisionKit.
 *
 * Los QR en facturas electrónicas colombianas apuntan a:
 *   https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey={CUFE}
 *
 * Al escanear:
 * 1. Extraer el CUFE de la URL.
 * 2. Abrir WebView con la URL para validación.
 * 3. Opcionalmente: descargar XML desde la URL de descarga del proveedor (si disponible).
 */
export default function QRScannerScreen({ onClose }: Props): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.placeholder}>📷 Escáner QR</Text>
      <Text style={styles.note}>
        Disponible en Fase 5.{'\n'}
        Requiere build nativo con EAS.{'\n'}
        (react-native-vision-camera + MLKit)
      </Text>
      <TouchableOpacity style={styles.closeButton} onPress={onClose}>
        <Text style={styles.closeText}>Cerrar</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
  },
  placeholder: { fontSize: 48, marginBottom: 16 },
  note: { color: '#d1d5db', textAlign: 'center', fontSize: 14, lineHeight: 22, marginBottom: 32 },
  closeButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '600' },
})
