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

/**
 * Calls `onBack` each time the phone's network comes back after it could
 * not reach the internet: never for the state it is in when the watch
 * begins, which the network library reports at once.
 */
export function watchReachableAgain(onBack: () => void): () => void {
  let reachable: boolean | undefined
  return addEventListener(state => {
    const now =
      state.isConnected === true && state.isInternetReachable !== false
    const was = reachable
    reachable = now
    if (now && was === false) onBack()
  })
}
