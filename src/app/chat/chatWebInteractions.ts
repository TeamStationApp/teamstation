/** DOM interactions belong to the browser twin; phones import no DOM code. */
import type { ChatBounds } from './chatInteractionModel'
export { useLayoutEffect as useChatOverlayCommit } from 'react'
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

/** Read the mounted viewport before RNW's throttled scroll callback arrives. */
export function readMessageScrollPosition(
  view: unknown,
  rows: ReadonlyMap<string, unknown>
):
  | {
      offset: number
      anchor: { id: string; relativeY: number } | undefined
      geometry?: { height: number; content: number }
    }
  | undefined {
  const element = scrollElement(view)
  if (element == null) return undefined
  const pane = element.getBoundingClientRect()
  if (pane.width <= 0 || pane.height <= 0) return undefined
  const positions = [...rows]
    .flatMap(([id, row]) => {
      if (!(row instanceof HTMLElement) || !element.contains(row)) return []
      const bounds = row.getBoundingClientRect()
      return bounds.width > 0 && bounds.height > 0
        ? [{ id, y: bounds.top }]
        : []
    })
    .sort((a, b) => a.y - b.y)
  const chosen =
    positions.find(row => row.y >= pane.top && row.y < pane.bottom) ??
    positions.filter(row => row.y <= pane.top).at(-1)
  const height = element.clientHeight
  const content = element.scrollHeight
  return {
    offset: Math.max(0, element.scrollTop),
    ...([height, content].every(Number.isFinite) && height > 0 && content > 0
      ? { geometry: { height, content } }
      : {}),
    anchor:
      chosen == null
        ? undefined
        : { id: chosen.id, relativeY: chosen.y - pane.top }
  }
}

export function cancelUserScroll(view: unknown): void {
  const element = scrollElement(view)
  if (element != null) scrollCancels.get(element)?.()
}

export function bindUserScroll(
  view: unknown,
  read: () => void,
  position?: (offset: number) => void,
  motion?: () => void
): () => void {
  const element = scrollElement(view)
  const win = element?.ownerDocument.defaultView
  if (element == null || win == null) return () => {}
  const supportsEnd = Reflect.has(element, 'onscrollend')
  let live = true
  let scrollbarHeld = false
  let touchHeld = false
  let touchY: number | undefined
  let physical = { x: element.scrollLeft, y: element.scrollTop }
  let pending:
    | {
        last: number
        height: number
        content: number
        direction: number
        target?: number
        input?: Event
        owned: boolean
      }
    | undefined
  const offset = (): number => Math.max(0, element.scrollTop)
  const maximum = (): number =>
    Math.max(0, element.scrollHeight - element.clientHeight)
  const retire = (): void => {
    pending = undefined
  }
  const cancel = (): void => {
    scrollbarHeld = false
    touchHeld = false
    touchY = undefined
    retire()
  }
  scrollCancels.set(element, retire)
  const allowed = (event: Event): boolean => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !element.contains(target))
      return false
    let node: HTMLElement = target
    while (node !== element) {
      if (
        node.matches(
          'input, textarea, select, button, [contenteditable], [role="slider"], [role="combobox"], [role="listbox"]'
        )
      )
        return false
      const style = win.getComputedStyle(node)
      if (
        node.scrollHeight > node.clientHeight &&
        (style.overflowY === 'auto' || style.overflowY === 'scroll')
      )
        return false
      if (node.parentElement == null) return false
      node = node.parentElement
    }
    return true
  }
  const arm = (
    input: Event,
    direction: number,
    target?: number,
    owned = false
  ): void => {
    retire()
    if (!live || (input.defaultPrevented && !owned)) return
    read()
    const top = offset()
    if (
      (direction === 0 && !scrollbarHeld) ||
      (direction < 0 && top === 0) ||
      (direction > 0 && top >= maximum())
    )
      return
    pending = {
      last: top,
      height: element.clientHeight,
      content: element.scrollHeight,
      direction,
      target,
      input,
      owned
    }
  }
  const deliver = (): void => {
    if (pending == null) return
    const top = offset()
    if (top === pending.last) return
    if (
      !scrollbarHeld &&
      !touchHeld &&
      pending.direction !== 0 &&
      (top - pending.last) * pending.direction < 0
    ) {
      retire()
      return
    }
    pending.last = top
    position?.(top)
    if (
      !scrollbarHeld &&
      !touchHeld &&
      pending.target != null &&
      (pending.direction < 0 ? top <= pending.target : top >= pending.target)
    )
      retire()
  }
  const direct = (event: Event, delta: number): void => {
    if (event.defaultPrevented) {
      retire()
      return
    }
    if (delta === 0) {
      retire()
      read()
      return
    }
    const before = offset()
    const target = Math.min(maximum(), Math.max(0, before + delta))
    event.preventDefault()
    arm(event, Math.sign(delta), target, true)
    if (pending != null) {
      // This is the application's finite legacy step, not an inferred UA step.
      element.scrollTop = target
      deliver()
    }
    retire()
  }
  const scroll = (event: Event): void => {
    if (!live || event.target !== element) return
    const next = { x: element.scrollLeft, y: element.scrollTop }
    // Observe physical motion before RNW throttles its notification. A delayed
    // packet for movement before a press must not cancel that stationary hold.
    if (
      !Number.isFinite(next.x) ||
      !Number.isFinite(next.y) ||
      next.x !== physical.x ||
      next.y !== physical.y
    )
      motion?.()
    physical = next
    if (pending == null) {
      if (scrollbarHeld) arm(event, 0)
      return
    }
    if (pending.input?.defaultPrevented === true && !pending.owned) {
      retire()
      return
    }
    if (
      pending.height !== element.clientHeight ||
      pending.content !== element.scrollHeight
    ) {
      if (scrollbarHeld) arm(event, 0)
      else retire()
      return
    }
    deliver()
  }
  const end = (event: Event): void => {
    if (event.target !== element || scrollbarHeld || touchHeld) return
    retire()
  }
  const key = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || !allowed(event))
      return
    const up =
      ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
      (event.key === ' ' && event.shiftKey)
    const down =
      ['ArrowDown', 'PageDown', 'End'].includes(event.key) ||
      (event.key === ' ' && !event.shiftKey)
    if (!up && !down) return
    const target =
      event.key === 'Home' ? 0 : event.key === 'End' ? maximum() : undefined
    if (
      !supportsEnd &&
      target == null &&
      position != null &&
      event.target === element
    ) {
      const step = event.key.startsWith('Arrow') ? 40 : element.clientHeight
      direct(event, up ? -step : step)
    } else if (supportsEnd || target != null || position == null)
      arm(event, up ? -1 : 1, target)
    else read()
  }
  const wheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || !allowed(event))
      return
    if (!supportsEnd && position != null) {
      // Legacy line units use current CSS line height, or the app's40px step.
      const line = Number.parseFloat(win.getComputedStyle(element).lineHeight)
      const unit =
        event.deltaMode === 1
          ? Number.isFinite(line)
            ? line
            : 40
          : event.deltaMode === 2
            ? element.clientHeight
            : 1
      direct(event, event.deltaY * unit)
    } else arm(event, Math.sign(event.deltaY))
  }
  const touchStart = (event: TouchEvent): void => {
    touchY = event.touches?.[0]?.clientY
    touchHeld = touchY != null
  }
  const touchMove = (event: TouchEvent): void => {
    if (!allowed(event)) return
    const next = event.touches?.[0]?.clientY
    if (next == null || touchY == null) {
      read()
      return
    }
    const delta = touchY - next
    touchY = next
    arm(event, Math.sign(delta))
  }
  const touchEnd = (): void => {
    touchHeld = false
    touchY = undefined
    // Legacy inertia remains observable as offsets, without inferred ownership.
    if (!supportsEnd) retire()
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
    arm(event, 0)
  }
  const pointerCancel = (): void => {
    scrollbarHeld = false
    // Browser panning can cancel pointer events while touch events continue.
    if (!touchHeld) retire()
  }
  const finish = (): void => {
    if (!scrollbarHeld) return
    scrollbarHeld = false
    if (!supportsEnd) retire()
  }
  const focus = (event: Event): void => {
    if (event.target !== element) retire()
  }
  const doc = element.ownerDocument
  element.addEventListener('scroll', scroll, true)
  element.addEventListener('scrollend', end)
  element.addEventListener('focusin', focus)
  element.addEventListener('pointerdown', start)
  element.addEventListener('mousedown', start)
  doc.addEventListener('pointerup', finish)
  doc.addEventListener('mouseup', finish)
  doc.addEventListener('pointercancel', pointerCancel)
  win.addEventListener('blur', cancel)
  const inputTarget = position != null ? win : element
  inputTarget.addEventListener('wheel', wheel as EventListener, {
    passive: false
  })
  element.addEventListener('touchstart', touchStart, { passive: true })
  element.addEventListener('touchmove', touchMove, { passive: true })
  element.addEventListener('touchend', touchEnd)
  element.addEventListener('touchcancel', cancel)
  inputTarget.addEventListener('keydown', key as EventListener)
  return () => {
    live = false
    cancel()
    if (scrollCancels.get(element) === retire) scrollCancels.delete(element)
    element.removeEventListener('scroll', scroll, true)
    element.removeEventListener('scrollend', end)
    element.removeEventListener('focusin', focus)
    element.removeEventListener('pointerdown', start)
    element.removeEventListener('mousedown', start)
    doc.removeEventListener('pointerup', finish)
    doc.removeEventListener('mouseup', finish)
    doc.removeEventListener('pointercancel', pointerCancel)
    win.removeEventListener('blur', cancel)
    inputTarget.removeEventListener('wheel', wheel as EventListener)
    element.removeEventListener('touchstart', touchStart)
    element.removeEventListener('touchmove', touchMove)
    element.removeEventListener('touchend', touchEnd)
    element.removeEventListener('touchcancel', cancel)
    inputTarget.removeEventListener('keydown', key as EventListener)
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
export function bindPopupKeys(
  view: unknown,
  close: () => void,
  trap = true,
  initialField = false,
  rowSelector?: string,
  returnFocus?: unknown
): () => void {
  if (!(view instanceof HTMLElement)) return () => {}
  const previous =
    returnFocus instanceof HTMLElement ? returnFocus : document.activeElement
  const buttons = (): HTMLElement[] =>
    Array.from(
      view.querySelectorAll<HTMLElement>(
        initialField
          ? '[role="button"],button,[tabindex="0"],input,textarea'
          : '[role="button"],button,[tabindex="0"]'
      )
    )
  const key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (!trap) return
    const fieldActive =
      document.activeElement?.tagName === 'INPUT' ||
      document.activeElement?.tagName === 'TEXTAREA'
    if (
      initialField &&
      fieldActive &&
      (event.key === 'Home' || event.key === 'End')
    )
      return
    const nodes =
      rowSelector != null &&
      (event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Home' ||
        event.key === 'End')
        ? Array.from(view.querySelectorAll<HTMLElement>(rowSelector))
        : buttons()
    const index = nodes.indexOf(document.activeElement as HTMLElement)
    let next: number | undefined
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey))
      next = (index + 1) % nodes.length
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey))
      next =
        index < 0 ? nodes.length - 1 : (index - 1 + nodes.length) % nodes.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = nodes.length - 1
    if (next != null && nodes.length > 0) {
      event.preventDefault()
      nodes[next].focus()
    }
  }
  document.addEventListener('keydown', key, true)
  if (trap) {
    const field = initialField
      ? view.querySelector<HTMLElement>('input,textarea')
      : null
    if (field != null) field.focus()
    else buttons()[0]?.focus()
  }
  return () => {
    document.removeEventListener('keydown', key, true)
    if (
      trap &&
      previous instanceof HTMLElement &&
      previous.isConnected &&
      (document.activeElement === document.body ||
        view.contains(document.activeElement))
    ) {
      restoringFocus = true
      try {
        previous.focus({ preventScroll: true })
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

/**
 * The browser's visible bottom includes its actual software keyboard.
 *
 * Pinch zoom also shrinks the visual viewport, but only in layout pixels:
 * its height times its scale still fills the screen. A keyboard is what
 * leaves that zoom-independent height short.
 */
export function watchVisualViewport(
  update: (value: { bottom: number; keyboardOpen: boolean }) => void
): () => void {
  const viewport = window.visualViewport
  if (viewport == null) return () => {}
  let width = window.innerWidth
  let closedHeight = Math.max(
    window.innerHeight,
    viewport.height * viewport.scale
  )
  const changed = (): void => {
    const bottom = viewport.offsetTop + viewport.height
    const visible = viewport.height * viewport.scale
    if (window.innerWidth !== width) {
      width = window.innerWidth
      closedHeight = window.innerHeight
    } else closedHeight = Math.max(closedHeight, window.innerHeight, visible)
    update({ bottom, keyboardOpen: visible < closedHeight - 80 })
  }
  viewport.addEventListener('resize', changed)
  viewport.addEventListener('scroll', changed)
  changed()
  return () => {
    viewport.removeEventListener('resize', changed)
    viewport.removeEventListener('scroll', changed)
  }
}

/** Apply a caret after the controlled text commit, keeping focus synchronous. */
export function setComposerSelection(
  view: unknown,
  selection: { start: number; end: number }
): void {
  if (
    view instanceof HTMLElement &&
    (view.tagName === 'INPUT' || view.tagName === 'TEXTAREA')
  )
    (view as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
      selection.start,
      selection.end
    )
}
