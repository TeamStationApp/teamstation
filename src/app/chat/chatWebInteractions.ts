/** DOM interactions belong to the browser twin; phones import no DOM code. */
let restoringFocus = false
export const immediatePressProps = { delayPressIn: 0 }
export function isRestoringPopupFocus(): boolean {
  return restoringFocus
}
export function bindPopupKeys(view: unknown, close: () => void): () => void {
  if (!(view instanceof HTMLElement)) return () => {}
  const previous = document.activeElement
  const buttons = (): HTMLElement[] =>
    Array.from(
      view.querySelectorAll<HTMLElement>(
        '[role="button"],button,[tabindex="0"]'
      )
    )
  const key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    const nodes = buttons()
    const index = nodes.indexOf(document.activeElement as HTMLElement)
    let next: number | undefined
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey))
      next = (index + 1) % nodes.length
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey))
      next = (index - 1 + nodes.length) % nodes.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = nodes.length - 1
    if (next != null && nodes.length > 0) {
      event.preventDefault()
      nodes[next].focus()
    }
  }
  document.addEventListener('keydown', key, true)
  buttons()[0]?.focus()
  return () => {
    document.removeEventListener('keydown', key, true)
    if (previous instanceof HTMLElement && previous.isConnected) {
      restoringFocus = true
      try {
        previous.focus()
      } finally {
        restoringFocus = false
      }
    }
  }
}
