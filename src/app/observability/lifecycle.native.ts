import { AppState } from 'react-native'

export const isForeground = (): boolean => AppState.currentState === 'active'

export function observeLifecycle(
  change: (active: boolean) => void,
  _leaving?: () => void
): () => void {
  const subscription = AppState.addEventListener('change', state => {
    change(state === 'active')
  })
  return () => {
    subscription.remove()
  }
}
