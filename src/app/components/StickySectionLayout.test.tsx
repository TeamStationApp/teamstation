import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Dimensions, Text } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { HeaderSlotProvider } from './headerSlot'
import { usePinned } from './pinnedGlass'
import { SceneTopProvider } from './sceneTop'
import { StickySectionLayout } from './StickySectionLayout'

/**
 * The browser's sticky section layout, against a page whose layout is played
 * by hand: jsdom lays nothing out, so the scroller, the marker and the
 * section report what a browser would, given the scroll.
 */
const HEADER = 100
/** The marker's natural top in the scroller's content: under a 400px hero. */
const NATURAL = 400
const SECTION = 60
/** Where the section meets the header. */
const PIN_AT = NATURAL - HEADER
/** The column's gap, as a browser computes it. */
const GAP = 16

let root: Root | undefined
let host: HTMLElement | undefined
let scrollTop = 0
let carried: boolean | undefined
let scrolled = 0

/** Whether any band carries the header's glass, as the header reads it. */
function Header(): null {
  carried = usePinned()
  return null
}

interface Props {
  top?: boolean
  scrollRef?: React.ComponentProps<typeof StickySectionLayout>['scrollRef']
}

function Page(props: Props): React.ReactElement {
  return (
    <ThemeProvider>
      <HeaderSlotProvider headerHeight={HEADER} onHandoff={() => undefined}>
        <Header />
        <SceneTopProvider value={props.top ?? true}>
          <StickySectionLayout
            hero={<Text>Season identity</Text>}
            sections={<Text>Season sections</Text>}
            onScroll={() => {
              scrolled++
            }}
            scrollRef={props.scrollRef}
          >
            <Text>Season games</Text>
          </StickySectionLayout>
        </SceneTopProvider>
      </HeaderSlotProvider>
    </ThemeProvider>
  )
}

const byId = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

/** The element that scrolls: the nearest one above the marker that does. */
function scroller(): HTMLElement {
  let node = byId('sticky-section-marker').parentElement
  while (node != null && !/auto|scroll/.test(getComputedStyle(node).overflowY))
    node = node.parentElement
  return node!
}

/** A rectangle the window's width across, as `getBoundingClientRect` gives. */
function box(top: number, height: number): DOMRect {
  const rect = { x: 0, y: top, left: 0, top, width: 393, height }
  return {
    ...rect,
    right: 393,
    bottom: top + height,
    toJSON: () => rect
  }
}

/** Plays the browser's layout on the rendered page. */
function layOut(): void {
  const page = scroller()
  Object.defineProperty(page, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (y: number) => {
      scrollTop = y
    }
  })
  page.getBoundingClientRect = () => box(0, 852)
  const marker = byId('sticky-section-marker')
  marker.getBoundingClientRect = () => box(NATURAL - scrollTop, 0)
  Object.defineProperty(byId('sticky-season-sections'), 'offsetHeight', {
    configurable: true,
    get: () => SECTION
  })
  marker.parentElement!.style.rowGap = `${GAP}px`
}

async function render(props: Props = {}): Promise<void> {
  scrollTop = 0
  scrolled = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Page {...props} />)
  })
  layOut()
  await setScroll(0)
}

async function rerender(props: Props): Promise<void> {
  await act(async () => {
    root!.render(<Page {...props} />)
  })
}

/** Scrolls the page to `y` and waits out the scroll view's last event. */
async function setScroll(y: number): Promise<void> {
  scrollTop = y
  await act(async () => {
    scroller().dispatchEvent(new window.Event('scroll'))
    await new Promise(resolve => setTimeout(resolve, 150))
  })
}

const pane = (): { top: string; height: string } => {
  const { top, height } = byId('sticky-section-glass').style
  return { top, height }
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

describe('the sticky section layout in a browser', function () {
  it('places the pane from the top of the screen to how far it has grown', async function () {
    await render()
    // At rest the section is PIN_AT below the header: the pane is the
    // header's height, from the top of the screen.
    expect(pane()).deep.equals({
      top: `${-(HEADER + PIN_AT)}px`,
      height: `${HEADER}px`
    })
    // A section-height from the header, it has not grown yet.
    await setScroll(PIN_AT - SECTION)
    expect(pane()).deep.equals({
      top: `${-(HEADER + SECTION)}px`,
      height: `${HEADER}px`
    })
    // Halfway there, it has grown half the section's height.
    await setScroll(PIN_AT - SECTION / 2)
    expect(pane()).deep.equals({
      top: `${-(HEADER + SECTION / 2)}px`,
      height: `${HEADER + SECTION / 2}px`
    })
    // Pinned, and beyond: from the top of the screen to the section's
    // lower edge.
    for (const y of [PIN_AT, PIN_AT + 500]) {
      await setScroll(y)
      expect(pane()).deep.equals({
        top: `${-HEADER}px`,
        height: `${HEADER + SECTION}px`
      })
    }
  })

  it('takes back the column’s gap after its marker, so the section does not move', async function () {
    await render()
    const marker = byId('sticky-section-marker')
    expect(marker.style.marginBottom).equals(`${-GAP}px`)
    // In the column, just before the section.
    expect(marker.nextElementSibling).equals(byId('sticky-season-sections'))
  })

  it('gives a caller’s object and function refs the scroller, and still calls its onScroll', async function () {
    const object: { current: unknown } = { current: null }
    await render({
      scrollRef: object as React.RefObject<never>
    })
    const node = (
      object.current as { getScrollableNode: () => unknown }
    ).getScrollableNode()
    expect(node).equals(scroller())
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()

    const called: unknown[] = []
    await render({
      scrollRef: (instance: unknown) => {
        if (instance != null) called.push(instance)
      }
    })
    expect(called).length.greaterThan(0)
    expect(
      (called[0] as { getScrollableNode: () => unknown }).getScrollableNode()
    ).equals(scroller())
    const before = scrolled
    await setScroll(PIN_AT)
    expect(scrolled).greaterThan(before)
    // Its own update ran on the same scroll.
    expect(pane().height).equals(`${HEADER + SECTION}px`)
  })

  it('reports the glass carried once the pane grows, and not on the way back', async function () {
    await render()
    expect(carried).equals(false)
    await setScroll(PIN_AT - SECTION)
    expect(carried).equals(false)
    await setScroll(PIN_AT - SECTION + 1)
    expect(carried).equals(true)
    await setScroll(PIN_AT + 200)
    expect(carried).equals(true)
    await setScroll(PIN_AT - SECTION)
    expect(carried).equals(false)
  })

  it('is transparent with the glass and its line while it carries it, opaque without', async function () {
    await render()
    const section = byId('sticky-season-sections')
    const glass = byId('sticky-section-glass')
    expect(section.style.backgroundColor).not.equals('transparent')
    expect(section.style.backgroundColor).not.equals('')
    expect(glass.children).length(0)
    await setScroll(PIN_AT)
    expect(section.style.backgroundColor).equals('transparent')
    // The glass, then the 1px line at its lower edge.
    expect(glass.children).length(2)
    const line = getComputedStyle(glass.children[1])
    expect(line.height).equals('1px')
    expect(line.bottom).equals('0px')
    // Behind the section's own content, and wider than its column.
    expect(glass.style.zIndex).equals('-1')
    const wide = `${-Dimensions.get('window').width}px`
    expect([glass.style.left, glass.style.right]).deep.equals([wide, wide])
    expect(glass.style.pointerEvents).equals('none')
    await setScroll(0)
    expect(section.style.backgroundColor).not.equals('transparent')
    expect(glass.children).length(0)
  })

  it('reports only while its scene is the top, and again when it is the top once more', async function () {
    await render()
    await setScroll(PIN_AT)
    expect(carried).equals(true)
    // A screen pushed over it: the pane keeps its growth, the header its glass.
    await rerender({ top: false })
    expect(carried).equals(false)
    expect(pane().height).equals(`${HEADER + SECTION}px`)
    await setScroll(PIN_AT + 10)
    expect(carried).equals(false)
    // Back, with no scroll: it carries the glass again.
    await rerender({ top: true })
    expect(carried).equals(true)
  })

  it('lets go of the glass when it goes', async function () {
    await render()
    await setScroll(PIN_AT)
    expect(carried).equals(true)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <Header />
        </ThemeProvider>
      )
    })
    expect(carried).equals(false)
  })

  it('moves the pin when the page’s layout changes under it, with no scroll', async function () {
    const observers: Array<{ observed: Element[]; callback: () => void }> = []
    const saved = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observed: Element[] = []
      constructor(public callback: () => void) {
        observers.push(this)
      }

      observe(node: Element): void {
        this.observed.push(node)
      }

      disconnect(): void {
        this.observed = []
      }
    }
    try {
      await render()
      await setScroll(PIN_AT)
      expect(pane().height).equals(`${HEADER + SECTION}px`)
      const watching = observers.find(o => o.observed.length > 0)!
      // The section and its column, which grows with anything above it.
      expect(watching.observed).deep.equals([
        byId('sticky-season-sections'),
        byId('sticky-section-marker').parentElement
      ])
      // The hero grows by 100 under a pinned section: it is 100 from the pin.
      byId('sticky-section-marker').getBoundingClientRect = () =>
        box(NATURAL + 100 - scrollTop, 0)
      await act(async () => {
        watching.callback()
      })
      expect(pane()).deep.equals({
        top: `${-(HEADER + 100)}px`,
        height: `${HEADER}px`
      })
      expect(carried).equals(false)
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      expect(watching.observed).length(0)
    } finally {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved
    }
  })
})
