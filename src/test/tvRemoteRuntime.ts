/** Unit event transport; UIKit routing is exercised separately on the simulator. */
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
