/** Browser visibility is independent of focus; pagehide flushes a departing page. */
export const isForeground = (): boolean => !document.hidden

export function observeLifecycle(
  change: (active: boolean) => void,
  leaving: () => void = () => {}
): () => void {
  const visibility = (): void => {
    change(isForeground())
  }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', leaving)
  return () => {
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pagehide', leaving)
  }
}
