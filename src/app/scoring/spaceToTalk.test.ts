import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { SpaceToTalkOptions, TalkKeys } from './dictationTypes'
import { useSpaceToTalk } from './spaceToTalk'

/** What the hook did to the microphone, in order. */
type Call = ['hold', number | undefined] | ['release']

interface Props {
  active: boolean
  talks: boolean
  options?: SpaceToTalkOptions
}

/**
 * A clock the test moves by hand: `setTimeout`, `clearTimeout` and
 * `Date.now`, swapped in while a press is under test, since the hook arms
 * its timer from a key handler outside React.
 */
function fakeClock(): {
  advance: (ms: number) => void
  restore: () => void
} {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now
  }
  let time = 1_700_000_000_000
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    const id = next++
    timers.set(id, { at: time + ms, run })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id)
  }) as typeof clearTimeout
  Date.now = () => time
  return {
    advance: ms => {
      const end = time + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort(([, a], [, b]) => a.at - b.at)[0]
        if (due == null) break
        timers.delete(due[0])
        time = due[1].at
        due[1].run()
      }
      time = end
    },
    restore: () => {
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      Date.now = real.now
    }
  }
}

let root: Root | undefined
let host: HTMLElement | undefined
let clock: ReturnType<typeof fakeClock> | undefined
const added: Element[] = []
/** Whether the microphone refuses a hold: reconnecting, or still busy. */
let refusing = false

afterEach(async () => {
  clock?.restore()
  clock = undefined
  refusing = false
  const mounted = root
  root = undefined
  if (mounted != null)
    await act(async () => {
      mounted.unmount()
    })
  host?.remove()
  host = undefined
  for (const node of added.splice(0)) node.remove()
})

/** Mounts the hook, and returns its calls and a way to re-render it. */
async function mount(
  props: Props,
  more: Props[] = []
): Promise<{
  calls: Call[]
  others: Call[][]
  render: (next: Props) => Promise<void>
}> {
  const make = (into: Call[]): { current: TalkKeys } => ({
    current: {
      hold: since => {
        into.push(['hold', since])
        return !refusing
      },
      release: () => into.push(['release'])
    }
  })
  const calls: Call[] = []
  const keys = make(calls)
  const others = more.map(() => [] as Call[])
  const otherKeys = others.map(make)
  function Probe({ active, talks, options }: Props): null {
    useSpaceToTalk(active, talks, keys, options)
    return null
  }
  function Other({ index }: { index: number }): null {
    const { active, talks, options } = more[index]
    useSpaceToTalk(active, talks, otherKeys[index], options)
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  const mounted = createRoot(host)
  root = mounted
  const render = async (next: Props): Promise<void> => {
    await act(async () => {
      mounted.render(
        createElement(
          'div',
          null,
          ...more.map((_, index) =>
            createElement(Other, { key: index, index })
          ),
          createElement(Probe, next)
        )
      )
    })
  }
  await render(props)
  clock = fakeClock()
  return { calls, others, render }
}

/** A Space key event from `target`, and whether something prevented its default. */
function space(
  type: 'keydown' | 'keyup',
  target: EventTarget = document.body,
  more: KeyboardEventInit = {}
): boolean {
  const event = new window.KeyboardEvent(type, {
    key: ' ',
    code: 'Space',
    bubbles: true,
    cancelable: true,
    ...more
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

/**
 * A key typed into `field` as the browser types it: down, its letter at the
 * caret unless something prevented that, then up.
 */
function typeKey(field: HTMLTextAreaElement, key: string): void {
  const down = new window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true
  })
  field.dispatchEvent(down)
  if (!down.defaultPrevented)
    field.setRangeText(key, field.selectionStart, field.selectionEnd, 'end')
  field.dispatchEvent(
    new window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })
  )
}

/** A quick press and release on `target`. */
function tap(target: EventTarget, more: KeyboardEventInit = {}): void {
  expect(space('keydown', target, more)).equals(true)
  clock!.advance(120)
  expect(space('keyup', target, more)).equals(true)
}

function add<T extends HTMLElement>(node: T): T {
  document.body.appendChild(node)
  added.push(node)
  return node
}

/** A box that scrolls, with the height and scroll position a layout would give it. */
function scroller(): HTMLDivElement {
  const box = add(document.createElement('div'))
  box.style.overflowY = 'auto'
  let top = 0
  Object.defineProperty(box, 'clientHeight', { value: 400 })
  Object.defineProperty(box, 'scrollHeight', { value: 2000 })
  Object.defineProperty(box, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = value
    }
  })
  return box
}

const HOLD: Props = { active: true, talks: true, options: { holdMs: 500 } }

describe('Space held to talk', function () {
  it('types a space at the caret on a short press in a text field', async function () {
    const { calls } = await mount(HOLD)
    const field = add(document.createElement('textarea'))
    field.value = 'ab'
    field.focus()
    field.setSelectionRange(1, 1)
    const inputs: string[] = []
    field.addEventListener('input', event => {
      inputs.push((event as InputEvent).inputType)
    })
    // A field's Space is taken on the way in: whatever else listens to it
    // on the page never hears it, since the field would only type it.
    const heard: string[] = []
    for (const type of ['keydown', 'keyup'])
      field.addEventListener(type, event => {
        heard.push(`${event.type}:${(event as KeyboardEvent).key}`)
      })
    tap(field)
    expect(field.value).equals('a b')
    expect(field.selectionStart).equals(2)
    expect(field.selectionEnd).equals(2)
    expect(inputs).deep.equals(['insertText'])
    expect(heard).deep.equals([])
    expect(calls).deep.equals([])
    // A selection is replaced, as typing replaces it.
    field.setSelectionRange(0, 2)
    tap(field)
    expect(field.value).equals(' b')
    expect(field.selectionStart).equals(1)
  })

  it('writes nothing into a read-only or disabled field on a short press', async function () {
    const { calls } = await mount(HOLD)
    for (const lock of ['readOnly', 'disabled'] as const) {
      const field = add(document.createElement('input'))
      field.type = 'text'
      field.value = 'Locked'
      field[lock] = true
      const inputs: string[] = []
      field.addEventListener('input', () => {
        inputs.push('input')
      })
      field.focus()
      tap(field)
      expect(field.value, lock).equals('Locked')
      expect(inputs, lock).deep.equals([])
    }
    expect(calls).deep.equals([])
  })

  it('types through the editing command where the browser has one', async function () {
    await mount(HOLD)
    const field = add(document.createElement('input'))
    field.value = 'x'
    field.focus()
    const commands: string[] = []
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string, _ui: boolean, value: string) => {
        commands.push(`${command}:${value}`)
        field.value += value
        return true
      }
    })
    try {
      tap(field)
    } finally {
      Reflect.deleteProperty(document, 'execCommand')
    }
    expect(commands).deep.equals(['insertText: '])
    expect(field.value).equals('x ')
  })

  it('types into a search field and contenteditable, and leaves other inputs be', async function () {
    await mount(HOLD)
    const search = add(document.createElement('input'))
    search.type = 'search'
    search.value = 'a'
    tap(search)
    expect(search.value).equals('a ')
    // An email field has no caret to put it at, and trims its value.
    const email = add(document.createElement('input'))
    email.type = 'email'
    email.value = 'a'
    const emailInputs: string[] = []
    email.addEventListener('input', () => emailInputs.push('input'))
    tap(email)
    expect(email.value).equals('a')
    expect(emailInputs).deep.equals([])
    const editable = add(document.createElement('div'))
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'ab'
    const inputs: string[] = []
    editable.addEventListener('input', () => inputs.push('input'))
    editable.focus()
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(editable.firstChild!, 1)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    tap(editable)
    expect(editable.textContent).equals('a b')
    expect(inputs).deep.equals(['input'])
    // No selection anywhere: nothing is typed.
    selection.removeAllRanges()
    tap(editable)
    expect(editable.textContent).equals('a b')
    // A slider takes the press and does nothing with it.
    const range2 = add(document.createElement('input'))
    range2.type = 'range'
    const box = scroller()
    box.appendChild(range2)
    tap(range2)
    expect(box.scrollTop).equals(0)
  })

  it('clicks a focused button, tab, checkbox or switch on a short press', async function () {
    const { calls } = await mount(HOLD)
    const clicked: string[] = []
    const make = (tag: string, role?: string, type?: string): HTMLElement => {
      const node = add(document.createElement(tag))
      if (role != null) node.setAttribute('role', role)
      if (type != null) (node as HTMLInputElement).type = type
      node.addEventListener('click', () => clicked.push(role ?? type ?? tag))
      return node
    }
    for (const node of [
      make('button'),
      make('div', 'tab'),
      make('div', 'button'),
      make('div', 'switch'),
      make('input', undefined, 'checkbox')
    ])
      tap(node)
    expect(clicked).deep.equals([
      'button',
      'tab',
      'button',
      'switch',
      'checkbox'
    ])
    expect(calls).deep.equals([])
  })

  it('pages the scroller down on a short press, and up with Shift', async function () {
    await mount(HOLD)
    const box = scroller()
    const link = document.createElement('a')
    link.href = '#'
    box.appendChild(link)
    tap(link)
    expect(box.scrollTop).equals(340)
    tap(link, { shiftKey: true })
    expect(box.scrollTop).equals(0)
    // With the focus on the page, the scroller last pressed in moves.
    const inside = document.createElement('span')
    box.appendChild(inside)
    inside.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
    tap(document.body)
    expect(box.scrollTop).equals(340)
  })

  it('pages the page itself where nothing around the focus scrolls', async function () {
    await mount(HOLD)
    const page = document.documentElement
    const moved: number[] = []
    Object.defineProperty(page, 'scrollBy', {
      configurable: true,
      value: ({ top }: { top: number }) => moved.push(top)
    })
    try {
      const plain = add(document.createElement('div'))
      plain.tabIndex = 0
      tap(plain)
      // The element last pressed in has gone: the page moves.
      const gone = document.createElement('span')
      document.body.appendChild(gone)
      gone.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
      gone.remove()
      tap(document.body, { shiftKey: true })
    } finally {
      Reflect.deleteProperty(page, 'scrollBy')
    }
    const step = Math.round(window.innerHeight * 0.85)
    expect(moved).deep.equals([step, -step])
  })

  it('talks after 500 ms held, from when the key went down', async function () {
    const { calls } = await mount(HOLD)
    const field = add(document.createElement('textarea'))
    field.focus()
    const pressed = Date.now()
    expect(space('keydown', field)).equals(true)
    clock!.advance(499)
    expect(calls).deep.equals([])
    // The key repeats while it is held; every repeat is swallowed.
    expect(space('keydown', field, { repeat: true })).equals(true)
    clock!.advance(1)
    expect(calls).deep.equals([['hold', pressed]])
    expect(space('keydown', field, { repeat: true })).equals(true)
    clock!.advance(800)
    expect(space('keyup', field)).equals(true)
    expect(calls).deep.equals([['hold', pressed], ['release']])
    // Nothing was typed, and a stray keyup afterwards is the page's.
    expect(field.value).equals('')
    expect(space('keyup', field)).equals(false)
  })

  it('is a tap at 499 ms', async function () {
    const { calls } = await mount(HOLD)
    const button = add(document.createElement('button'))
    let clicks = 0
    button.addEventListener('click', () => clicks++)
    expect(space('keydown', button)).equals(true)
    clock!.advance(499)
    expect(space('keyup', button)).equals(true)
    clock!.advance(1000)
    expect(clicks).equals(1)
    expect(calls).deep.equals([])
  })

  it('cancels when the window loses focus, pending or held', async function () {
    const { calls } = await mount(HOLD)
    const button = add(document.createElement('button'))
    let clicks = 0
    button.addEventListener('click', () => clicks++)
    space('keydown', button)
    window.dispatchEvent(new window.Event('blur'))
    clock!.advance(1000)
    expect(space('keyup', button)).equals(false)
    expect(calls).deep.equals([])
    expect(clicks).equals(0)
    space('keydown', button)
    clock!.advance(500)
    window.dispatchEvent(new window.Event('blur'))
    expect(calls).deep.equals([['hold', Date.now() - 500], ['release']])
    expect(space('keyup', button)).equals(false)
    expect(clicks).equals(0)
  })

  it('leaves modifiers, a select, other keys and a handled Space alone', async function () {
    const { calls } = await mount(HOLD)
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing'])
      expect(space('keydown', document.body, { [modifier]: true })).equals(
        false
      )
    const select = add(document.createElement('select'))
    expect(space('keydown', select)).equals(false)
    expect(space('keyup', select)).equals(false)
    const other = new window.KeyboardEvent('keydown', {
      key: 'b',
      bubbles: true,
      cancelable: true
    })
    document.body.dispatchEvent(other)
    expect(other.defaultPrevented).equals(false)
    // Handled before the hook hears it: a listener on the window.
    const first = (event: KeyboardEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('keydown', first, true)
    try {
      space('keydown', document.body)
    } finally {
      window.removeEventListener('keydown', first, true)
    }
    // A repeat with no press under way began before the hook listened.
    expect(space('keydown', document.body, { repeat: true })).equals(false)
    clock!.advance(1000)
    expect(calls).deep.equals([])
  })

  it('types rolled keys in order: the space lands before the next letter', async function () {
    const { calls } = await mount(HOLD)
    const field = add(document.createElement('textarea'))
    field.focus()
    for (const key of 'hello') typeKey(field, key)
    // Space goes down, w goes down before Space comes up, then w comes up.
    expect(space('keydown', field)).equals(true)
    clock!.advance(40)
    const w = new window.KeyboardEvent('keydown', {
      key: 'w',
      bubbles: true,
      cancelable: true
    })
    field.dispatchEvent(w)
    expect(w.defaultPrevented, 'w is typed as it was').equals(false)
    expect(field.value).equals('hello ')
    field.setRangeText('w', field.selectionStart, field.selectionEnd, 'end')
    clock!.advance(30)
    expect(
      space('keyup', field),
      'the tap was played; its keyup is ours'
    ).equals(true)
    field.dispatchEvent(
      new window.KeyboardEvent('keyup', { key: 'w', bubbles: true })
    )
    for (const key of 'orld') typeKey(field, key)
    clock!.advance(1000)
    expect(field.value).equals('hello world')
    expect(calls).deep.equals([])
  })

  it('plays a pending tap before any other key, and only then', async function () {
    const { calls } = await mount(HOLD)
    const button = add(document.createElement('button'))
    const order: string[] = []
    button.addEventListener('click', () => order.push('click'))
    button.addEventListener('keydown', event => order.push(event.key))
    expect(space('keydown', button)).equals(true)
    expect(order).deep.equals([' '])
    // A modifier going down types nothing, so the press stays a press.
    button.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true })
    )
    expect(order).deep.equals([' ', 'Shift'])
    button.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
    )
    expect(order).deep.equals([' ', 'Shift', 'click', 'Tab'])
    // Its repeats and its keyup are still swallowed, and nothing listens.
    expect(space('keydown', button, { repeat: true })).equals(true)
    clock!.advance(1000)
    expect(space('keyup', button)).equals(true)
    expect(calls).deep.equals([])
    expect(order).deep.equals([' ', 'Shift', 'click', 'Tab'])
    // A key while it is held leaves the hold be.
    space('keydown', button)
    clock!.advance(500)
    button.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'a', bubbles: true })
    )
    expect(calls).deep.equals([['hold', Date.now() - 500]])
    expect(space('keyup', button)).equals(true)
    expect(calls).deep.equals([['hold', Date.now() - 500], ['release']])
    expect(order.filter(entry => entry === 'click')).has.length(1)
  })

  it('is a tap when the microphone refuses the hold', async function () {
    const { calls } = await mount(HOLD)
    refusing = true
    const field = add(document.createElement('textarea'))
    field.value = 'ab'
    field.focus()
    field.setSelectionRange(1, 1)
    const pressed = Date.now()
    expect(space('keydown', field)).equals(true)
    clock!.advance(800)
    expect(space('keyup', field)).equals(true)
    // Asked once, refused, and nothing to let go: the space is typed.
    expect(calls).deep.equals([['hold', pressed]])
    expect(field.value).equals('a b')
    // Refused, a key typed while Space is down still comes after its space.
    expect(space('keydown', field)).equals(true)
    clock!.advance(600)
    typeKey(field, 'c')
    expect(space('keyup', field)).equals(true)
    expect(field.value).equals('a  cb')
    expect(calls).has.length(2)
  })

  it('leaves Space to an element that handles it, or whose key it is', async function () {
    const { calls } = await mount(HOLD)
    // The scoring field: Space grabs a player, and is the field's whether
    // or not it grabbed one.
    const field = add(document.createElement('div'))
    field.setAttribute('role', 'application')
    field.tabIndex = 0
    const inside = document.createElement('span')
    field.appendChild(inside)
    const grabbed: string[] = []
    field.addEventListener('keydown', event => {
      if (event.key === ' ' && event.target === field) {
        grabbed.push('grab')
        event.preventDefault()
      }
    })
    for (const target of [field, inside]) {
      space('keydown', target)
      clock!.advance(1000)
      space('keyup', target)
    }
    expect(grabbed).deep.equals(['grab'])
    const inField = new window.KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true
    })
    inside.dispatchEvent(inField)
    expect(inField.defaultPrevented, 'not taken inside the field').equals(false)
    clock!.advance(1000)
    space('keyup', inside)
    // A video plays and pauses on its own Space.
    const video = add(document.createElement('video'))
    expect(space('keydown', video)).equals(false)
    clock!.advance(1000)
    expect(space('keyup', video)).equals(false)
    // Any element that took the key on its way out keeps it.
    const own = add(document.createElement('div'))
    own.tabIndex = 0
    own.addEventListener('keydown', event => {
      event.preventDefault()
    })
    space('keydown', own)
    clock!.advance(1000)
    expect(space('keyup', own)).equals(false)
    expect(calls).deep.equals([])
  })

  it('intercepts nothing while push-to-talk is off or Space is not the talk key', async function () {
    const { calls, render } = await mount({ ...HOLD, active: false })
    const field = add(document.createElement('textarea'))
    expect(space('keydown', field)).equals(false)
    clock!.advance(1000)
    expect(space('keyup', field)).equals(false)
    await render({ ...HOLD, talks: false })
    expect(space('keydown', field)).equals(false)
    clock!.advance(1000)
    expect(space('keyup', field)).equals(false)
    expect(calls).deep.equals([])
    // Switched off mid-hold, it lets go.
    await render(HOLD)
    space('keydown', field)
    clock!.advance(500)
    const pressed = Date.now() - 500
    await render({ ...HOLD, active: false })
    expect(calls).deep.equals([['hold', pressed], ['release']])
    expect(space('keyup', field)).equals(false)
  })

  it("leaves Space to a screen's immediate push-to-talk that is also on", async function () {
    const immediate: Props = { active: true, talks: true }
    const { calls, others } = await mount(HOLD, [immediate])
    expect(space('keydown')).equals(true)
    clock!.advance(1000)
    expect(space('keyup')).equals(true)
    expect(others[0]).deep.equals([['hold', undefined], ['release']])
    expect(calls).deep.equals([])
    // In a field the immediate key steps aside, and the held one types.
    const field = add(document.createElement('textarea'))
    tap(field)
    expect(field.value).equals(' ')
    expect(others[0]).to.have.length(2)
  })
})

describe('Space to talk at once, as scoring has it', function () {
  it('talks the moment Space goes down and never types, clicks or scrolls', async function () {
    const { calls } = await mount({ active: true, talks: true })
    const button = add(document.createElement('button'))
    let clicks = 0
    button.addEventListener('click', () => clicks++)
    expect(space('keydown', button)).equals(true)
    expect(calls).deep.equals([['hold', undefined]])
    expect(space('keydown', button, { repeat: true })).equals(true)
    expect(space('keyup', button)).equals(true)
    expect(calls).deep.equals([['hold', undefined], ['release']])
    expect(clicks).equals(0)
    // A text field keeps its Space, with no timer behind it.
    const field = add(document.createElement('textarea'))
    expect(space('keydown', field)).equals(false)
    clock!.advance(1000)
    expect(space('keyup', field)).equals(false)
    expect(calls).to.have.length(2)
  })
})
