import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { PinnedHead } from './pinnedHead'
import { usePinnedHead } from './usePinnedHead'

/**
 * The browser's pinned head, against a page whose layout is played by hand:
 * jsdom lays nothing out, so each band reports the rectangle a browser would,
 * given the scroll offset and whether the band is stuck.
 */
const HEADER = 100
const VIEWPORT = 800
/** The column's gap and the screen's bottom margin, below the room. */
const TAIL = 150

/** Natural tops and heights, in page coordinates (the column starts at 100). */
const LAYOUT = {
  column: { top: HEADER, height: 2000 },
  card: { top: HEADER, height: 200 },
  pills: { top: HEADER + 200, height: 60 },
  content: { top: HEADER + 280, height: 1000 },
  row: { top: HEADER + 280 + 500, height: 90 }
}
const PIN_AT = LAYOUT.pills.top - LAYOUT.column.top

let root: Root | undefined
let host: HTMLElement | undefined
let scrollTop = 0

interface HarnessProps {
  tab: string
  ready: boolean
  anchorOnRow: boolean
  /** Its page drawn after it slides in, as `TabPages` keeps one. */
  late?: boolean
  /** Asks where the page is, into `positions`. */
  track?: boolean
  followEnd?: boolean
}

let head: PinnedHead | undefined
let drawPage: (() => void) | undefined
const calls: string[] = []
const positions: Array<{ y: number; end: number }> = []
const named = (name: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-name="${name}"]`)!

const ref = (value: unknown): React.Ref<HTMLDivElement> =>
  value as React.Ref<HTMLDivElement>

/** A spinner, until its own commit draws the page: the screen's does not. */
function LatePage(props: { head: PinnedHead }): React.ReactElement {
  const [drawn, setDrawn] = useState(false)
  drawPage = () => {
    setDrawn(true)
  }
  return drawn ? (
    <div data-name="content" ref={ref(props.head.content.ref)}>
      <div data-name="row" ref={ref(props.head.nextRow.ref)} />
    </div>
  ) : (
    <div data-name="spinner" />
  )
}

function Harness(props: HarnessProps): React.ReactElement {
  const { tab, ready, anchorOnRow, late = false, track = false } = props
  head = usePinnedHead({
    followEnd: props.followEnd,
    onPosition: track
      ? at => {
          positions.push(at)
        }
      : undefined,
    headerHeight: HEADER,
    ready,
    tab,
    anchorOnRow,
    tail: TAIL,
    onScroll: () => {
      // What the hand-off would read: the styles are already written.
      calls.push(`scroll card=${named('card').style.top}`)
    }
  })
  return (
    <div
      data-name="scroller"
      style={{ overflowY: 'auto' }}
      onScroll={() => {
        ;(head!.screen.onScroll as () => void)()
      }}
    >
      <div data-name="column">
        <div data-name="card" ref={ref(head.cardBand.ref)} />
        <div data-name="pills" ref={ref(head.pillBand.ref)} />
        {late ? (
          <LatePage key={tab} head={head} />
        ) : (
          <div key={tab} data-name="content" ref={ref(head.content.ref)}>
            {anchorOnRow && <div data-name="row" ref={ref(head.nextRow.ref)} />}
          </div>
        )}
        <div data-name="spacer" ref={ref(head.spacer.ref)} />
      </div>
    </div>
  )
}

/**
 * Every element reports the rectangle a browser would draw for it now: its
 * natural place less the scroll, or where it is stuck.
 */
const original = {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored onto the prototype it came from
  rect: HTMLElement.prototype.getBoundingClientRect,
  clientHeight: Object.getOwnPropertyDescriptor(
    Element.prototype,
    'clientHeight'
  ),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
}
function installLayout(): void {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const name = this.dataset.name
    if (name === 'scroller') {
      return {
        top: 0,
        bottom: VIEWPORT,
        height: VIEWPORT
      } as unknown as DOMRect
    }
    if (name === 'spacer') {
      const height =
        this.style.height === '' ? 0 : Number.parseFloat(this.style.height)
      return { top: 0, bottom: height, height } as unknown as DOMRect
    }
    const place = LAYOUT[name as keyof typeof LAYOUT]
    if (place == null) return original.rect.call(this)
    let at = place.top - scrollTop
    if (this.style.position === 'sticky') {
      at = Math.max(at, Number.parseFloat(this.style.top))
    }
    return {
      top: at,
      bottom: at + place.height,
      height: place.height
    } as unknown as DOMRect
  }
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.name === 'scroller' ? VIEWPORT : 0
    }
  })
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.name === 'scroller' ? scrollTop : 0
    },
    set(this: HTMLElement, y: number) {
      if (this.dataset.name === 'scroller') scrollTop = y
    }
  })
}

let props: HarnessProps = { tab: 'videos', ready: true, anchorOnRow: false }

async function mount(initial: Partial<HarnessProps> = {}): Promise<void> {
  installLayout()
  scrollTop = 0
  calls.length = 0
  positions.length = 0
  props = { tab: 'videos', ready: true, anchorOnRow: false, ...initial }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Harness {...props} />)
  })
}

async function rerender(patch: Partial<HarnessProps>): Promise<void> {
  props = { ...props, ...patch }
  await act(async () => {
    root!.render(<Harness {...props} />)
  })
}

async function setScroll(y: number): Promise<void> {
  scrollTop = y
  await act(async () => {
    named('scroller').dispatchEvent(new window.Event('scroll'))
  })
}

/** A pill tapped: the head is told, and the new tab drawn, in one render. */
async function select(tab: string, anchorOnRow: boolean): Promise<void> {
  props = { ...props, tab, anchorOnRow }
  await act(async () => {
    head!.select(tab)
    root!.render(<Harness {...props} />)
  })
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
  HTMLElement.prototype.getBoundingClientRect = original.rect
  for (const key of ['clientHeight', 'scrollTop'] as const) {
    const descriptor = original[key]
    if (descriptor != null)
      Object.defineProperty(Element.prototype, key, descriptor)
  }
})

describe('the pinned head in a browser', function () {
  it('sticks the pills under the header and leaves the card in the flow', async function () {
    await mount()
    expect(named('pills').style.position).equals('sticky')
    expect(named('pills').style.top).equals(`${HEADER}px`)
    expect(named('card').style.position).equals('')
    expect(named('scroller').scrollTop).equals(0)
  })

  it('makes room so even a short tab can be dragged until the pills pin', async function () {
    await mount()
    // Content ends at 1380; pinning needs 200 + 800 of page below the top.
    expect(named('spacer').style.height).equals('0px')
    LAYOUT.content.height = 300
    try {
      await select('team', false)
      const bottom = LAYOUT.content.top + 300
      // Exactly enough: with the tail below it, the page stops where the
      // pills pin over the tab's top, not past it.
      expect(named('spacer').style.height).equals(
        `${PIN_AT + VIEWPORT - (bottom + TAIL)}px`
      )
    } finally {
      LAYOUT.content.height = 1000
    }
  })

  it('opens the schedule at its next game without moving the card', async function () {
    await mount()
    await select('schedule', true)
    const rowOffset = LAYOUT.row.top - LAYOUT.content.top
    expect(named('scroller').scrollTop).equals(rowOffset)
    // Held: both bands stuck exactly where they were drawn at rest.
    expect(named('card').style.position).equals('sticky')
    expect(named('card').style.top).equals(`${HEADER}px`)
    expect(named('pills').style.top).equals(`${HEADER + PIN_AT}px`)
    expect(calls.at(-1)).equals(`scroll card=${HEADER}px`)
  })

  it('ignores the scroll its own jump causes', async function () {
    await mount()
    await select('schedule', true)
    await setScroll(named('scroller').scrollTop)
    expect(named('card').style.top).equals(`${HEADER}px`)
  })

  it('takes the head up with the content, and back down to the top', async function () {
    await mount()
    await select('schedule', true)
    const anchor = named('scroller').scrollTop
    await setScroll(anchor - 200)
    expect(named('card').style.top).equals(`${HEADER}px`)
    await setScroll(anchor - 200 + 60)
    expect(named('card').style.top).equals(`${HEADER - 60}px`)
    expect(named('pills').style.top).equals(`${HEADER + PIN_AT - 60}px`)
    expect(calls.at(-1)).equals(`scroll card=${HEADER - 60}px`)
    await setScroll(0)
    expect(named('card').style.position).equals('')
    expect(named('pills').style.top).equals(`${HEADER}px`)
  })

  it('measures where the pills belong, not where they are stuck', async function () {
    await mount()
    // Pinned in step, far down the page: the pills report the header's edge.
    await setScroll(900)
    expect(named('pills').getBoundingClientRect().top).equals(HEADER)
    await select('schedule', true)
    const rowOffset = LAYOUT.row.top - LAYOUT.content.top
    expect(named('scroller').scrollTop).equals(rowOffset + PIN_AT)
    expect(named('pills').style.top).equals(`${HEADER}px`)
  })

  it('keeps pinned pills pinned when a tab starts at its top', async function () {
    await mount()
    await setScroll(900)
    await select('stats', false)
    expect(named('scroller').scrollTop).equals(PIN_AT)
    expect(named('card').style.position).equals('')
    expect(named('pills').style.top).equals(`${HEADER}px`)
  })

  it('holds the head while the new tab lands, whatever the page does', async function () {
    await mount()
    await setScroll(900)
    props = { ...props, tab: 'videos' }
    await act(async () => {
      head!.select('videos')
      // The provisional room: wherever the page is, plus a screen.
      expect(named('spacer').style.height).equals(`${900 + VIEWPORT}px`)
      // A clamp as short content lands is not a scroll the head follows.
      scrollTop = 150
      named('scroller').dispatchEvent(new window.Event('scroll'))
      root!.render(<Harness {...props} />)
    })
    expect(named('scroller').scrollTop).equals(PIN_AT)
    expect(named('pills').style.top).equals(`${HEADER}px`)
  })

  it('waits for the content before anchoring', async function () {
    await mount({ ready: false })
    expect(named('scroller').scrollTop).equals(0)
    await rerender({ ready: false, tab: 'schedule', anchorOnRow: true })
    expect(named('scroller').scrollTop).equals(0)
    await rerender({ ready: true })
    expect(named('scroller').scrollTop).equals(
      LAYOUT.row.top - LAYOUT.content.top
    )
  })

  it('opens a kept schedule at its next game once it is drawn, pinned pills staying pinned', async function () {
    const watchers: Array<() => void> = []
    const observed = new Set<Element>()
    const globals = globalThis as { ResizeObserver?: unknown }
    const before = globals.ResizeObserver
    globals.ResizeObserver = class {
      constructor(callback: () => void) {
        watchers.push(callback)
      }

      observe(node: Element): void {
        observed.add(node)
      }

      unobserve(node: Element): void {
        observed.delete(node)
      }

      disconnect(): void {
        observed.clear()
      }
    }
    try {
      await mount()
      await setScroll(PIN_AT + 300)
      expect(named('pills').style.top).equals(`${HEADER}px`)
      props = { ...props, late: true }
      await select('schedule', true)
      // A spinner: the tab stands at its top, with the pills where they were.
      expect(named('scroller').scrollTop).equals(PIN_AT)
      expect(named('pills').style.top).equals(`${HEADER}px`)
      // Landed: the page draws itself, and the screen does not commit.
      await act(async () => {
        drawPage!()
      })
      expect(observed.has(named('content'))).equals(true)
      await act(async () => {
        for (const watcher of watchers) watcher()
      })
      const rowOffset = LAYOUT.row.top - LAYOUT.content.top
      expect(named('scroller').scrollTop).equals(PIN_AT + rowOffset)
      expect(named('pills').style.top).equals(`${HEADER}px`)
    } finally {
      globals.ResizeObserver = before
    }
  })

  it('holds the head while a kept tab at its top is drawn, whatever the page does', async function () {
    const watchers: Array<() => void> = []
    const globals = globalThis as { ResizeObserver?: unknown }
    const before = globals.ResizeObserver
    globals.ResizeObserver = class {
      constructor(callback: () => void) {
        watchers.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    try {
      await mount()
      await setScroll(PIN_AT + 300)
      props = { ...props, late: true }
      await select('stats', false)
      expect(named('scroller').scrollTop).equals(PIN_AT)
      // Landed: a long list drawing has the page shorter for a moment, which
      // pulls it to the top without anybody scrolling.
      await act(async () => {
        drawPage!()
        scrollTop = 0
        named('scroller').dispatchEvent(new window.Event('scroll'))
      })
      await act(async () => {
        for (const watcher of watchers) watcher()
      })
      expect(named('scroller').scrollTop).equals(PIN_AT)
      expect(named('pills').style.top).equals(`${HEADER}px`)
    } finally {
      globals.ResizeObserver = before
    }
  })

  it('reads where the pills pin again when the card changes height', async function () {
    // jsdom has no ResizeObserver: a stand-in that the test can fire.
    const watchers: Array<() => void> = []
    const observed = new Set<Element>()
    const globals = globalThis as { ResizeObserver?: unknown }
    const before = globals.ResizeObserver
    globals.ResizeObserver = class {
      constructor(callback: () => void) {
        watchers.push(callback)
      }

      observe(node: Element): void {
        observed.add(node)
      }

      unobserve(node: Element): void {
        observed.delete(node)
      }

      disconnect(): void {
        observed.clear()
      }
    }
    try {
      await mount()
      // Watched from the first commit: the card, the tab and the page.
      expect(observed.has(named('card'))).equals(true)
      expect(observed.has(named('content'))).equals(true)
      expect(observed.has(named('scroller'))).equals(true)
      const oldContent = named('content')
      await select('schedule', true)
      // A new tab is a new view, as on the team screen: the old one has left
      // the page and is let go of, and the new one is watched.
      expect(oldContent.isConnected).equals(false)
      expect(observed.has(oldContent)).equals(false)
      expect(observed.has(named('content'))).equals(true)
      expect(named('pills').style.top).equals(`${HEADER + PIN_AT}px`)
      // The team's name wraps: the card is 40 taller, and so is pinAt.
      LAYOUT.pills.top += 40
      LAYOUT.content.top += 40
      LAYOUT.row.top += 40
      await act(async () => {
        for (const watcher of watchers) watcher()
      })
      expect(named('pills').style.top).equals(`${HEADER + PIN_AT + 40}px`)
    } finally {
      LAYOUT.pills.top -= 40
      LAYOUT.content.top -= 40
      LAYOUT.row.top -= 40
      globals.ResizeObserver = before
    }
  })

  it('holds a row anchor as the rows above it settle, with no room after the last row, until somebody scrolls', async function () {
    const watchers: Array<() => void> = []
    const globals = globalThis as { ResizeObserver?: unknown }
    const before = globals.ResizeObserver
    globals.ResizeObserver = class {
      constructor(callback: () => void) {
        watchers.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const heightOf = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight'
    )
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.name !== 'scroller') return 0
        const room = named('spacer').style.height
        return (
          LAYOUT.content.top +
          LAYOUT.content.height +
          TAIL +
          (room === '' ? 0 : Number.parseFloat(room))
        )
      }
    })
    const saved = { content: LAYOUT.content.height, row: LAYOUT.row.top }
    const resized = async (): Promise<void> => {
      await act(async () => {
        for (const watcher of watchers) watcher()
      })
    }
    try {
      await mount()
      await select('schedule', true)
      expect(named('scroller').scrollTop).equals(500)
      expect(named('spacer').style.height).equals('0px')
      // The rows above it settle 100 shorter: the page follows its row.
      LAYOUT.content.height -= 100
      LAYOUT.row.top -= 100
      await resized()
      expect(named('scroller').scrollTop).equals(400)
      expect(named('spacer').style.height).equals('0px')
      // Shorter again, so the page cannot reach the row, and the browser
      // pulls the page back to its new end before the tab is measured: the
      // page stays at its end, with no room under the last row.
      await setScroll(named('scroller').scrollTop)
      LAYOUT.content.height = 300
      LAYOUT.row.top = LAYOUT.content.top + 250
      await setScroll(30)
      expect(named('scroller').scrollTop).equals(30)
      expect(named('spacer').style.height).equals('0px')
      // That was the browser, not somebody scrolling: still held, so when
      // the rows grow back the page goes to its row again.
      LAYOUT.content.height = 900
      await resized()
      expect(named('scroller').scrollTop).equals(250)
      // Once somebody scrolls, the page is theirs.
      await setScroll(0)
      LAYOUT.row.top -= 50
      await resized()
      expect(named('scroller').scrollTop).equals(0)
    } finally {
      LAYOUT.content.height = saved.content
      LAYOUT.row.top = saved.row
      globals.ResizeObserver = before
      if (heightOf != null)
        Object.defineProperty(Element.prototype, 'scrollHeight', heightOf)
      else
        delete (Element.prototype as unknown as Record<string, unknown>)
          .scrollHeight
    }
  })

  it('keeps the page and pinned pills put when the tab shrinks under them', async function () {
    const watchers: Array<() => void> = []
    const globals = globalThis as { ResizeObserver?: unknown }
    const before = globals.ResizeObserver
    globals.ResizeObserver = class {
      constructor(callback: () => void) {
        watchers.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const height = LAYOUT.content.height
    const room = (): string =>
      `${PIN_AT + VIEWPORT - (LAYOUT.content.top + LAYOUT.content.height + TAIL)}px`
    try {
      // A short tab, opened with the pills pinned: the page ends where it is.
      LAYOUT.content.height = 200
      await mount()
      await setScroll(900)
      await select('stats', false)
      expect(named('scroller').scrollTop).equals(PIN_AT)
      expect(named('spacer').style.height).equals(room())
      // A filter leaves 100 less to show, and the browser pulls the page
      // back to its new end before the tab is measured again.
      LAYOUT.content.height -= 100
      scrollTop = PIN_AT - 100
      await act(async () => {
        for (const watcher of watchers) watcher()
      })
      expect(named('spacer').style.height).equals(room())
      expect(named('scroller').scrollTop).equals(PIN_AT)
      // The pull's own scroll, arriving after, finds nothing moved.
      await setScroll(named('scroller').scrollTop)
      expect(named('pills').style.top).equals(`${HEADER}px`)
      expect(named('card').style.position).equals('')
    } finally {
      LAYOUT.content.height = height
      globals.ResizeObserver = before
    }
  })

  it('puts the page back when the shrinking tab is scrolled before it is measured', async function () {
    // The page's height, as a browser lays it out: the tab and its room.
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight'
    )
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.name !== 'scroller') return 0
        const room = named('spacer').style.height
        return (
          LAYOUT.content.top +
          LAYOUT.content.height +
          TAIL +
          (room === '' ? 0 : Number.parseFloat(room))
        )
      }
    })
    const height = LAYOUT.content.height
    try {
      LAYOUT.content.height = 200
      await mount()
      await setScroll(900)
      await select('stats', false)
      expect(named('scroller').scrollTop).equals(PIN_AT)
      const room = Number.parseFloat(named('spacer').style.height)
      // The tab loses 100 and the browser's pull reaches the page first.
      LAYOUT.content.height -= 100
      await setScroll(PIN_AT - 100)
      expect(named('scroller').scrollTop).equals(PIN_AT)
      expect(named('spacer').style.height).equals(`${room + 100}px`)
      expect(named('pills').style.top).equals(`${HEADER}px`)
      // A scroll somebody makes is still followed, and left where it went.
      const told = calls.length
      await setScroll(PIN_AT - 50)
      expect(named('scroller').scrollTop).equals(PIN_AT - 50)
      expect(calls.length).equals(told + 1)
    } finally {
      LAYOUT.content.height = height
      if (original != null)
        Object.defineProperty(Element.prototype, 'scrollHeight', original)
    }
  })

  /** The page's height as a browser lays it out: the tab, its room, the tail. */
  function layOutPage(): () => void {
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight'
    )
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.name !== 'scroller') return 0
        const room = named('spacer').style.height
        return (
          LAYOUT.content.top +
          LAYOUT.content.height +
          TAIL +
          (room === '' ? 0 : Number.parseFloat(room))
        )
      }
    })
    return () => {
      if (original != null)
        Object.defineProperty(Element.prototype, 'scrollHeight', original)
      else
        delete (Element.prototype as unknown as Record<string, unknown>)
          .scrollHeight
    }
  }
  /** A ResizeObserver the test fires by hand. */
  function watchResizes(): { fire: () => Promise<void>; restore: () => void } {
    const watchers: Array<() => void> = []
    const globals = globalThis as { ResizeObserver?: unknown }
    const before = globals.ResizeObserver
    globals.ResizeObserver = class {
      constructor(callback: () => void) {
        watchers.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    return {
      fire: async () => {
        await act(async () => {
          for (const watcher of watchers) watcher()
        })
      },
      restore: () => {
        globals.ResizeObserver = before
      }
    }
  }
  /** Where the page ends with no room kept: the tab and the tail, less a screen. */
  const contentEnd = (): number =>
    Math.max(
      PIN_AT,
      LAYOUT.content.top + LAYOUT.content.height + TAIL - VIEWPORT
    )

  it('reports where the page is and where its content ends on a scroll, to a screen that asks', async function () {
    await mount({ track: true })
    await setScroll(300)
    expect(positions.at(-1)).deep.equals({ y: 300, end: contentEnd() })
    await setScroll(120)
    expect(positions.at(-1)).deep.equals({ y: 120, end: contentEnd() })
    // A screen that does not ask is told nothing, and scrolls as before.
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    await mount()
    await setScroll(300)
    expect(positions).deep.equals([])
    expect(named('pills').style.top).equals(`${HEADER}px`)
    expect(calls.at(-1)).equals(`scroll card=`)
  })

  it('scrolls to the end of the page, smoothly when asked', async function () {
    const unlay = layOutPage()
    try {
      await mount({ track: true })
      await act(async () => {
        head!.scrollToEnd(false)
      })
      expect(named('scroller').scrollTop).equals(contentEnd())
      expect(positions.at(-1)).deep.equals({
        y: contentEnd(),
        end: contentEnd()
      })
      expect(named('pills').style.top).equals(`${HEADER}px`)
      await setScroll(0)
      const smooth: ScrollToOptions[] = []
      named('scroller').scrollTo = ((options: ScrollToOptions) => {
        smooth.push(options)
      }) as typeof Element.prototype.scrollTo
      await act(async () => {
        head!.scrollToEnd(true)
      })
      expect(smooth).deep.equals([{ top: contentEnd(), behavior: 'smooth' }])
    } finally {
      unlay()
    }
  })

  it('waits for a pending anchor before scrolling to the end', async function () {
    const unlay = layOutPage()
    try {
      await mount({ ready: false })
      await act(async () => {
        head!.scrollToEnd(false)
      })
      expect(named('scroller').scrollTop).equals(0)
      await rerender({ ready: true })
      expect(named('scroller').scrollTop).equals(contentEnd())
    } finally {
      unlay()
    }
  })

  it('lets go of the room kept for a page that shrank at its end, and lands on the last content', async function () {
    const unlay = layOutPage()
    const height = LAYOUT.content.height
    try {
      await mount({ track: true })
      await setScroll(contentEnd())
      const end = contentEnd()
      // A line collapses: the browser pulls the page back, and the room is
      // kept for where it was, as on every pinned screen.
      LAYOUT.content.height -= 300
      await setScroll(contentEnd())
      expect(named('scroller').scrollTop).equals(end)
      expect(named('spacer').style.height).equals('300px')
      await act(async () => {
        head!.scrollToEnd(false)
      })
      expect(named('spacer').style.height).equals('0px')
      expect(named('scroller').scrollTop).equals(contentEnd())
      // The browser's own scroll as the room goes finds nothing to undo.
      await setScroll(named('scroller').scrollTop)
      expect(named('scroller').scrollTop).equals(contentEnd())
      expect(named('spacer').style.height).equals('0px')
      expect(positions.at(-1)).deep.equals({
        y: contentEnd(),
        end: contentEnd()
      })
      expect(named('pills').style.top).equals(`${HEADER}px`)
    } finally {
      LAYOUT.content.height = height
      unlay()
    }
  })

  it('keeps no room below a page that follows its end as its content shrinks', async function () {
    const unlay = layOutPage()
    const resizes = watchResizes()
    const height = LAYOUT.content.height
    try {
      await mount({ track: true, followEnd: true })
      await act(async () => {
        head!.scrollToEnd(false)
      })
      // A line collapses and the browser's pull reaches the page first.
      LAYOUT.content.height -= 300
      await setScroll(contentEnd())
      expect(named('spacer').style.height).equals('0px')
      expect(named('scroller').scrollTop).equals(contentEnd())
      expect(positions.at(-1)).deep.equals({
        y: contentEnd(),
        end: contentEnd()
      })
      // A line removed, measured before the browser pulls the page.
      LAYOUT.content.height -= 100
      await resizes.fire()
      expect(named('spacer').style.height).equals('0px')
      expect(named('scroller').scrollTop).equals(contentEnd())
      expect(positions.at(-1)).deep.equals({
        y: contentEnd(),
        end: contentEnd()
      })
      expect(named('pills').style.top).equals(`${HEADER}px`)
    } finally {
      LAYOUT.content.height = height
      resizes.restore()
      unlay()
    }
  })

  it('keeps the room for where the page was when it does not follow its end', async function () {
    const unlay = layOutPage()
    const resizes = watchResizes()
    const height = LAYOUT.content.height
    try {
      await mount({ track: true })
      await act(async () => {
        head!.scrollToEnd(false)
      })
      const end = contentEnd()
      LAYOUT.content.height -= 100
      await resizes.fire()
      expect(named('spacer').style.height).equals('100px')
      expect(named('scroller').scrollTop).equals(end)
      // Reported against the content, not the room: the page is past it.
      await setScroll(end)
      expect(positions.at(-1)).deep.equals({ y: end, end: contentEnd() })
    } finally {
      LAYOUT.content.height = height
      resizes.restore()
      unlay()
    }
  })
})
