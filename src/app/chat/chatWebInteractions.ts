/** DOM interactions belong to the browser twin; phones import no DOM code. */
import type { ChatBounds } from './chatInteractionModel'
let restoringFocus = false
export function readDocumentActive(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'visible'
  )
}
export function watchReadDocumentActive(
  update: (active: boolean) => void
): () => void {
  const changed = (): void => {
    update(readDocumentActive())
  }
  document.addEventListener('visibilitychange', changed)
  return () => {
    document.removeEventListener('visibilitychange', changed)
  }
}
export const immediatePressProps = { delayPressIn: 0 }
export const messageTooltipProps = (label: string): { title: string } => ({
  title: label
})
export function bindMessageTooltips(view: unknown): () => void {
  if (!(view instanceof HTMLElement)) return () => {}
  const buttons = [
    ...view.querySelectorAll<HTMLElement>('[role="button"][aria-label]')
  ]
  for (const button of buttons)
    button.title = button.getAttribute('aria-label') ?? ''
  return () => {
    for (const button of buttons) button.removeAttribute('title')
  }
}
export function isRestoringPopupFocus(): boolean {
  return restoringFocus
}
export function isFinePointer(): boolean {
  return (
    typeof matchMedia !== 'function' ||
    matchMedia('(any-pointer: fine)').matches
  )
}
export function bindComposerKeys(
  view: unknown,
  onSend: () => void
): () => void {
  if (!(view instanceof HTMLElement)) return () => {}
  let composing = false
  const start = (): void => {
    composing = true
  }
  const end = (): void => {
    composing = false
  }
  const key = (event: KeyboardEvent): void => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      !isFinePointer()
    )
      return
    event.preventDefault()
    if (!event.repeat) onSend()
  }
  view.addEventListener('compositionstart', start)
  view.addEventListener('compositionend', end)
  view.addEventListener('keydown', key)
  return () => {
    view.removeEventListener('compositionstart', start)
    view.removeEventListener('compositionend', end)
    view.removeEventListener('keydown', key)
  }
}
/** RNW's scroll-begin callback also fires for programmatic focus scrolling. */
export function bindUserScroll(view: unknown, read: () => void): () => void {
  const node = view as { getScrollableNode?: () => unknown } | null
  const element = node?.getScrollableNode?.() ?? view
  if (!(element instanceof HTMLElement)) return () => {}
  const key = (event: KeyboardEvent): void => {
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
        'Home',
        'End',
        ' '
      ].includes(event.key)
    )
      read()
  }
  element.addEventListener('wheel', read, { passive: true })
  element.addEventListener('touchmove', read, { passive: true })
  element.addEventListener('keydown', key)
  return () => {
    element.removeEventListener('wheel', read)
    element.removeEventListener('touchmove', read)
    element.removeEventListener('keydown', key)
  }
}
export function bindMessageHover(
  view: unknown,
  update: (visible: boolean) => void
): () => void {
  if (!(view instanceof HTMLElement)) return () => {}
  const enter = (): void => {
    update(true)
  }
  const leave = (): void => {
    update(view.contains(document.activeElement))
  }
  const focusOut = (event: FocusEvent): void => {
    if (!view.contains(event.relatedTarget as Node | null)) update(false)
  }
  const context = (event: Event): void => {
    if (!isFinePointer()) event.preventDefault()
  }
  view.addEventListener('pointerenter', enter)
  view.addEventListener('pointerleave', leave)
  view.addEventListener('focusin', enter)
  view.addEventListener('focusout', focusOut)
  view.addEventListener('contextmenu', context)
  return () => {
    view.removeEventListener('pointerenter', enter)
    view.removeEventListener('pointerleave', leave)
    view.removeEventListener('focusin', enter)
    view.removeEventListener('focusout', focusOut)
    view.removeEventListener('contextmenu', context)
  }
}
export function watchMessageAnchor(
  view: unknown,
  update: (bounds: ChatBounds) => void,
  close: () => void
): () => void {
  if (!(view instanceof HTMLElement)) {
    close()
    return () => {}
  }
  const measure = (): void => {
    if (!view.isConnected) {
      close()
      return
    }
    const bounds = view.getBoundingClientRect()
    update({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    })
  }
  measure()
  window.addEventListener('resize', measure)
  document.addEventListener('scroll', measure, true)
  const observer = new MutationObserver(measure)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', measure)
    document.removeEventListener('scroll', measure, true)
  }
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
