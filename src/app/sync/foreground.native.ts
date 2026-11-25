import { AppState } from 'react-native'

/**
 * Hears the app come to the front from anything else. Returns the way to
 * stop hearing.
 */
export function watchForeground(onForeground: () => void): () => void {
  let last = AppState.currentState
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'active' && last !== 'active') onForeground()
    last = state
  })
  return () => {
    subscription.remove()
  }
}
