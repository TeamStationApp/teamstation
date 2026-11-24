/**
 * The web's network watch: the window's `online` event, which the browser
 * fires once the device has a network again. A request that leaves still
 * finds out whether the server answers. The phone's is
 * `reachability.native.ts`.
 */
export function watchReachability(onReachable: () => void): () => void {
  if (typeof window?.addEventListener !== 'function') return () => undefined
  const online = (): void => {
    onReachable()
  }
  window.addEventListener('online', online)
  return () => {
    window.removeEventListener('online', online)
  }
}

/**
 * Calls `onBack` each time the page's network comes back: the window's
 * `online` event, which only a return sends.
 */
export function watchReachableAgain(onBack: () => void): () => void {
  return watchReachability(onBack)
}
