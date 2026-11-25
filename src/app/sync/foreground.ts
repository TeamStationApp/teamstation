/**
 * Hears the page come back into view: a tab shown again. Returns the way to
 * stop hearing. Where there is no page (a test), it hears nothing.
 */
export function watchForeground(onForeground: () => void): () => void {
  const page = globalThis as {
    document?: {
      visibilityState?: string
      addEventListener?: (name: string, run: () => void) => void
      removeEventListener?: (name: string, run: () => void) => void
    }
  }
  const document = page.document
  if (typeof document?.addEventListener !== 'function') return () => undefined
  const shown = (): void => {
    if (document.visibilityState !== 'hidden') onForeground()
  }
  document.addEventListener('visibilitychange', shown)
  return () => {
    document.removeEventListener?.('visibilitychange', shown)
  }
}
