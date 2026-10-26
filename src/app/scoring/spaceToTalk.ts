import { type RefObject, useEffect, useRef } from 'react'

import type { SpaceToTalkOptions, TalkKeys } from './dictationTypes'

/** Whether `target` is edited as text where it is: contenteditable. */
function editable(target: HTMLElement): boolean {
  return (
    target.isContentEditable ||
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
    ) != null
  )
}

/** Keys that type rather than act, where Space must stay a space. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    editable(target) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
}

/**
 * Space is push-to-talk anywhere on the page while dictation is on: held, it
 * holds the button; released, or when the window loses focus, it lets go. It
 * listens before anything else on the page, so the key it takes goes nowhere
 * else — no scroll, no click on a focused button, no player grabbed on a
 * focused field. It leaves Space alone while `talks` is off (the field is
 * drawing a play or dragging a player), for typing, and with a modifier.
 *
 * With `holdMs`, Space talks only once held that long, and a shorter press is
 * given back to the page (`useHeldSpace`).
 */
export function useSpaceToTalk(
  active: boolean,
  talks: boolean,
  keys: RefObject<TalkKeys>,
  options: SpaceToTalkOptions = {}
): void {
  const now = useRef(talks)
  now.current = talks
  const { holdMs } = options
  useEffect(() => {
    if (!active || holdMs != null) return
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
  }, [active, holdMs, keys])
  useHeldSpace(active && holdMs != null, now, keys, holdMs ?? 0)
}

interface Press {
  /** `Date.now()` at the keydown, the hold's `since`. */
  at: number
  /** Where Space would have gone: the focused element. */
  target: Element | null
  shift: boolean
  timer: ReturnType<typeof setTimeout>
  held: boolean
}

/** Keys that change another key rather than type or act themselves. */
const MODIFIERS = [
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock',
  'NumLock',
  'ScrollLock'
]

/**
 * Where Space is an element's own: the field's grab key on a canvas
 * (`role="application"`), and a media player's play and pause.
 */
const OWNS_SPACE = '[role="application"], video, audio'

/**
 * Space held `holdMs` talks, wherever the focus is, text fields included; a
 * shorter press does what Space would have done where it was pressed: in a
 * field a space is typed at the caret, on a button-like element it is
 * clicked, and elsewhere the scroller under it pages down (Shift+Space, up).
 * Every Space keydown nothing else took is held back, since whether it is a
 * hold is known only later. The press is a tap once the key comes up, and
 * also the moment another key goes down before it is held, so the space
 * lands before that key's letter when Space is rolled into the next one.
 * A hold the microphone refuses (reconnecting, or still busy) is a tap too.
 *
 * Elsewhere than in a text field, a new press is heard on the window as the
 * key bubbles out, after the element under the focus: a press an element
 * handled itself (a pressable that activates on Space) stays that element's,
 * as does one inside an element whose Space it is (the scoring field, a
 * video) and a `<select>`'s. A text field's Space is heard on the way in
 * instead, since a field only ever types it, which the tap does in its
 * place, and a field may stop the key before it bubbles out. A screen with
 * immediate Space-to-talk on keeps the key: its listener takes it on the
 * way in and stops it. The keys after a press are heard on the way in,
 * before anything acts on them.
 */
function useHeldSpace(
  active: boolean,
  talks: RefObject<boolean>,
  keys: RefObject<TalkKeys>,
  holdMs: number
): void {
  useEffect(() => {
    if (!active) return
    let press: Press | null = null
    // A press already played as a tap whose key is still down: its repeats
    // and its keyup are swallowed.
    let tapped = false
    // Where the pointer last went down: with the focus on the page itself,
    // Space pages the scroller under it, as the browser's own Space does.
    let pointed: Element | null = null
    const cancel = (): void => {
      tapped = false
      if (press == null) return
      const { timer, held } = press
      press = null
      clearTimeout(timer)
      if (held) keys.current.release()
    }
    /** The pending press, played now as the tap it turned out to be. */
    const tap = (): void => {
      if (press == null) return
      const { target, shift } = press
      cancel()
      tapped = true
      tapSpace(target, pointed, shift)
    }
    const swallow = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const start = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        !talks.current ||
        (event.target instanceof Element &&
          (event.target.tagName === 'SELECT' ||
            event.target.closest(OWNS_SPACE) != null))
      )
        return
      swallow(event)
      tapped = false
      const started: Press = {
        at: Date.now(),
        target: event.target instanceof Element ? event.target : null,
        shift: event.shiftKey,
        held: false,
        timer: setTimeout(() => {
          if (press !== started) return
          // Refused, it stays a press, and a tap on release.
          started.held = keys.current.hold(started.at)
        }, holdMs)
      }
      press = started
    }
    const before = (event: KeyboardEvent): void => {
      if (event.key === ' ') {
        // The key repeating while it is down.
        if (press != null || tapped) swallow(event)
        else if (typesText(event.target)) start(event)
        return
      }
      if (press != null && !press.held && !MODIFIERS.includes(event.key)) tap()
    }
    const after = (event: KeyboardEvent): void => {
      if (event.key === ' ' && press == null && !typesText(event.target))
        start(event)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || (press == null && !tapped)) return
      swallow(event)
      if (press == null || press.held) cancel()
      else tap()
      tapped = false
    }
    const point = (event: Event): void => {
      pointed = event.target instanceof Element ? event.target : null
    }
    window.addEventListener('keydown', before, true)
    window.addEventListener('keydown', after)
    window.addEventListener('keyup', up, true)
    document.addEventListener('pointerdown', point, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', before, true)
      window.removeEventListener('keydown', after)
      window.removeEventListener('keyup', up, true)
      document.removeEventListener('pointerdown', point, true)
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [active, holdMs, keys, talks])
}

const TEXT_INPUTS = ['text', 'search', 'url', 'tel', 'password', 'email']
const BUTTON_INPUTS = [
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'image',
  'file',
  'color'
]
const BUTTON_LIKE = [
  'button',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="option"]'
].join(', ')

/** What a Space press too short to talk does on `target`. */
function tapSpace(
  target: Element | null,
  pointed: Element | null,
  shift: boolean
): void {
  if (target != null && !target.isConnected) return
  if (target instanceof HTMLElement) {
    const field = textField(target)
    if (field != null) {
      typeSpace(field)
      return
    }
    if (target.tagName === 'INPUT') {
      const { type } = target as HTMLInputElement
      if (BUTTON_INPUTS.includes(type)) target.click()
      return
    }
    if (editable(target)) {
      typeSpace(target)
      return
    }
    if (target.matches(BUTTON_LIKE)) {
      target.click()
      return
    }
  }
  const onPage =
    target == null ||
    target === document.body ||
    target === document.documentElement
  pageDown(onPage && pointed?.isConnected === true ? pointed : target, shift)
}

/** Whether Space typed on `target` is a space in its text. */
function typesText(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (textField(target) != null || editable(target))
  )
}

/** `target` as a field that takes typed text, or null. */
function textField(
  target: HTMLElement
): HTMLInputElement | HTMLTextAreaElement | null {
  // A read-only or disabled field takes no typing (react-native-web renders
  // `editable={false}` as `readOnly`): Space there is the page's, as it is
  // anywhere else, and a short press must not write into it.
  const field =
    target.tagName === 'TEXTAREA'
      ? (target as HTMLTextAreaElement)
      : target.tagName === 'INPUT' &&
          TEXT_INPUTS.includes((target as HTMLInputElement).type)
        ? (target as HTMLInputElement)
        : null
  return field == null || field.readOnly || field.disabled ? null : field
}

/**
 * A space at the caret, replacing any selection, as typed: through the
 * editing command where the browser has it, so undo keeps it and `input`
 * fires, and otherwise set in place with an `input` event.
 */
function typeSpace(target: HTMLElement): void {
  if (document.activeElement !== target) target.focus()
  /* eslint-disable @typescript-eslint/no-deprecated -- no other call types into a field as the keyboard does, onto its undo stack */
  if (
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, ' ')
  )
    return
  /* eslint-enable @typescript-eslint/no-deprecated */
  const field = textField(target)
  if (field != null) {
    try {
      const start = field.selectionStart ?? field.value.length
      const end = field.selectionEnd ?? start
      field.setRangeText(' ', start, end, 'end')
    } catch {
      // A type without a caret (email) takes a space only from the editing
      // command: its value is trimmed.
      return
    }
  } else {
    const selection = window.getSelection()
    if (selection == null || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const space = document.createTextNode(' ')
    range.insertNode(space)
    range.setStartAfter(space)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  target.dispatchEvent(
    new window.InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: ' '
    })
  )
}

/** The nearest scroller around `from`, or the page, moved by 85% of its height. */
function pageDown(from: Element | null, shift: boolean): void {
  let node = from
  while (node != null && node !== document.body) {
    if (
      ['auto', 'scroll', 'overlay'].includes(
        getComputedStyle(node).overflowY
      ) &&
      node.scrollHeight > node.clientHeight
    )
      break
    node = node.parentElement
  }
  const page = node == null || node === document.body
  const scroller: Element =
    node == null || page
      ? (document.scrollingElement ?? document.documentElement)
      : node
  const height = page ? window.innerHeight : scroller.clientHeight
  const top = Math.round(height * 0.85) * (shift ? -1 : 1)
  if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ top })
  else scroller.scrollTop += top
}
