/** Unit event transport; UIKit routing is exercised separately on the simulator. */
// The runtime is aliased to react-native-web by the test bundle; ESLint cannot parse RN Flow.
// eslint-disable-next-line import/export
export * from 'react-native'
const listeners = new Set<
  (event: { eventType: string; eventKeyAction?: number }) => void
>()
export const TVEventHandler = {
  addListener(
    callback: (event: { eventType: string; eventKeyAction?: number }) => void
  ): { remove: () => void } {
    listeners.add(callback)
    return {
      remove: () => {
        listeners.delete(callback)
      }
    }
  }
}
export function emitTvDirection(eventType: string, eventKeyAction = 0): void {
  for (const listener of listeners) listener({ eventType, eventKeyAction })
}
