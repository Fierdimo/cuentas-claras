import { registerRootComponent } from 'expo';

import App from './App';

// Suprimir el rechazo de promesa de ExpoKeepAwake en Android cuando la Activity
// ya no está disponible (ocurre durante el redirect OAuth del deep link).
// Es inofensivo — Expo lo llama internamente al bootstrap y a veces la Activity
// se va antes de que pueda activarse.
const _global = global as typeof global & {
  HermesInternal?: unknown
  ErrorUtils?: { setGlobalHandler: (fn: (error: Error, isFatal: boolean) => void) => void }
}
if (_global.ErrorUtils) {
  const prevHandler = _global.ErrorUtils.setGlobalHandler
  _global.ErrorUtils.setGlobalHandler((error: Error, isFatal: boolean) => {
    if (error?.message?.includes('ExpoKeepAwake')) return  // ignorar — inofensivo
    prevHandler(error, isFatal)
  })
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
