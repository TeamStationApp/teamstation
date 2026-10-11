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
const scrollCancels = new WeakMap<HTMLElement, () => void>()
function scrollElement(view: unknown): HTMLElement | undefined {
  const node = view as { getScrollableNode?: () => unknown } | null
  const element = node?.getScrollableNode?.() ?? view
  return element instanceof HTMLElement ? element : undefined
}

export function cancelUserScroll(view: unknown): void {
  const element = scrollElement(view)
  if (element != null) scrollCancels.get(element)?.()
}

export function bindUserScroll(
  view: unknown,
  read: () => void,
  position?: (offset: number) => void
): () => void {
  const element = scrollElement(view)
  const win = element?.ownerDocument.defaultView
  if (element == null || win == null) return () => {}
  let live = true
  let scrollbarHeld = false
  let generation = 0
  let frame: number | undefined
  let pending:
    | { last: number; frameOffset: number; height: number; content: number }
    | undefined
  const offset = (): number => Math.max(0, element.scrollTop)
  const retire = (): void => {
    generation += 1
    pending = undefined
    if (frame != null) win.cancelAnimationFrame(frame)
    frame = undefined
  }
  const cancel = (): void => {
    scrollbarHeld = false
    retire()
  }
  scrollCancels.set(element, cancel)
  const observeFrame = (): void => {
    const current = generation
    frame = win.requestAnimationFrame(() => {
      if (!live || current !== generation || pending == null) return
      frame = undefined
      const top = offset()
      if (
        pending.height !== element.clientHeight ||
        pending.content !== element.scrollHeight ||
        top === pending.frameOffset
      ) {
        retire()
        return
      }
      pending.frameOffset = top
      observeFrame()
    })
  }
  const begin = (): void => {
    retire()
    const top = offset()
    pending = {
      last: top,
      frameOffset: top,
      height: element.clientHeight,
      content: element.scrollHeight
    }
    read()
    if (!scrollbarHeld) observeFrame()
  }
  const scroll = (event: Event): void => {
    if (event.target !== element || pending == null) return
    if (
      pending.height !== element.clientHeight ||
      pending.content !== element.scrollHeight
    ) {
      cancel()
      return
    }
    const top = offset()
    if (top === pending.last) return
    pending.last = top
    position?.(top)
  }
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
      begin()
  }
  // Bare content presses cannot own a native scrollbar's movement.
  const start = (event: MouseEvent): void => {
    if (event.button !== 0 || event.target !== element || scrollbarHeld) return
    const rect = element.getBoundingClientRect()
    const styles = getComputedStyle(element)
    const scaleX =
      element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1
    const scaleY =
      element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1
    const border = (value: string): number => {
      const parsed = Number.parseFloat(value)
      return Number.isNaN(parsed) ? 0 : parsed
    }
    const innerLeft = rect.left + border(styles.borderLeftWidth) * scaleX
    const innerRight = rect.right - border(styles.borderRightWidth) * scaleX
    const innerTop = rect.top + border(styles.borderTopWidth) * scaleY
    const innerBottom = rect.bottom - border(styles.borderBottomWidth) * scaleY
    const left = rect.left + element.clientLeft * scaleX
    const right = left + element.clientWidth * scaleX
    const top = rect.top + element.clientTop * scaleY
    const bottom = top + element.clientHeight * scaleY
    const vertical =
      element.scrollHeight > element.clientHeight &&
      event.clientY >= top &&
      event.clientY < bottom &&
      ((event.clientX >= innerLeft && event.clientX < left) ||
        (event.clientX >= right && event.clientX < innerRight))
    const horizontal =
      element.scrollWidth > element.clientWidth &&
      event.clientX >= left &&
      event.clientX < right &&
      ((event.clientY >= innerTop && event.clientY < top) ||
        (event.clientY >= bottom && event.clientY < innerBottom))
    if (!vertical && !horizontal) return
    scrollbarHeld = true
    begin()
  }
  const finish = (): void => {
    if (!scrollbarHeld) return
    scrollbarHeld = false
    // The final movement may be delivered at the next rendering opportunity.
    if (pending != null) observeFrame()
  }
  const doc = element.ownerDocument
  element.addEventListener('scroll', scroll, true)
  element.addEventListener('pointerdown', start)
  element.addEventListener('mousedown', start)
  doc.addEventListener('pointerup', finish)
  doc.addEventListener('mouseup', finish)
  doc.addEventListener('pointercancel', cancel)
  win.addEventListener('blur', cancel)
  element.addEventListener('wheel', begin, { passive: true })
  element.addEventListener('touchmove', begin, { passive: true })
  element.addEventListener('keydown', key)
  return () => {
    live = false
    cancel()
    if (scrollCancels.get(element) === cancel) scrollCancels.delete(element)
    element.removeEventListener('scroll', scroll, true)
    element.removeEventListener('pointerdown', start)
    element.removeEventListener('mousedown', start)
    doc.removeEventListener('pointerup', finish)
    doc.removeEventListener('mouseup', finish)
    doc.removeEventListener('pointercancel', cancel)
    win.removeEventListener('blur', cancel)
    element.removeEventListener('wheel', begin)
    element.removeEventListener('touchmove', begin)
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

/** Move focus only when a popup replaces its controls, preserving its lifetime owner. */
export function focusPopupControl(view: unknown): void {
  if (view instanceof HTMLElement)
    view
      .querySelector<HTMLElement>('[role="button"],button,[tabindex="0"]')
      ?.focus()
}
