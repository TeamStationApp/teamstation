import { type RefObject, useEffect, useRef } from 'react'

/** Keys that type rather than act, where Space must stay a space. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
    ) != null ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
}

/**
 * Space is push-to-talk anywhere on the page while dictation is on: held, it
 * holds the button; released, or when the window loses focus, it lets go. It
 * listens before anything else on the page, so the key it takes goes nowhere
 * else — no scroll, no click on a focused button, no player grabbed on a
 * focused field. It leaves Space alone while `talks` is off (the field is
 * drawing a play or dragging a player), for typing, and with a modifier.
 */
export function useSpaceToTalk(
  active: boolean,
  talks: boolean,
  keys: RefObject<{ hold: () => void; release: () => void }>
): void {
  const now = useRef(talks)
  now.current = talks
  useEffect(() => {
    if (!active) return
    let talking = false
    const letGo = (): void => {
      if (!talking) return
      talking = false
      keys.current.release()
    }
    const down = (event: KeyboardEvent): void => {
      if (
        event.key !== ' ' ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        typing(event.target) ||
        (!now.current && !talking)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat || talking) return
      talking = true
      keys.current.hold()
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || !talking) return
      event.preventDefault()
      event.stopPropagation()
      letGo()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', letGo)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', letGo)
      letGo()
    }
  }, [active, keys])
}
