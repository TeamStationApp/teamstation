import { addEventListener } from '@react-native-community/netinfo'

/**
 * Calls `onReachable` each time the phone's network says it can reach the
 * internet again. That only wakes the outbox: whether the server answers is
 * what the next request finds out.
 */
export function watchReachability(onReachable: () => void): () => void {
  return addEventListener(state => {
    if (state.isConnected === true && state.isInternetReachable !== false)
      onReachable()
  })
}
