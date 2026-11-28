import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import { pillPadding } from '../theme/pill'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { ContentInsetContext } from './contentInset'
import { GlassView } from './GlassView'
import { type PillTab, PillTabs, type PillTabsProps } from './PillTabs'

let root: Root | undefined
let host: HTMLElement | undefined
const restore: Array<() => void> = []

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
  while (restore.length > 0) restore.pop()!()
})

const TABS: PillTab[] = [
  { id: 'past', label: 'Past' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'all', label: 'All' }
]

/** Each target's x and width, in order, as the layouts below deliver them. */
const WIDTHS = [80, 120, 60]

const rem = (value: number): string => `${tsBallpark.rem(value)}px`

/** A `#rrggbb` color as the DOM writes it back. */
function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

interface Fiber {
  type: unknown
  memoizedProps: Record<string, unknown> | null
  return: Fiber | null
  child: Fiber | null
  sibling: Fiber | null
  stateNode: unknown
}

function fiberOf(node: Element): Fiber {
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber'))!
  return (node as unknown as Record<string, Fiber>)[key]
}

/** The props of the nearest component above `node` that takes `key`. */
function propsWith(node: Element, key: string): Record<string, unknown> {
  let fiber: Fiber | null = fiberOf(node)
  while (fiber != null && !(key in (fiber.memoizedProps ?? {})))
    fiber = fiber.return
  if (fiber == null) throw new Error(`nothing above takes ${key}`)
  return fiber.memoizedProps!
}

/**
 * The `GlassView` the pill holds, or undefined for a filled pill. Read from
 * the root's current tree: a node's own fiber can be the stale alternate.
 */
function glassOf(pill: HTMLElement): Record<string, unknown> | undefined {
  if (pill.firstElementChild == null) return undefined
  const key = Object.keys(host!).find(name =>
    name.startsWith('__reactContainer')
  )!
  const container = (host as unknown as Record<string, Fiber>)[key]
  const current = (container.stateNode as { current: Fiber }).current
  const stack: Array<Fiber | null> = [current]
  while (stack.length > 0) {
    const fiber = stack.pop()
    if (fiber == null) continue
    if (fiber.type === GlassView) return fiber.memoizedProps ?? undefined
    stack.push(fiber.sibling, fiber.child)
  }
  return undefined
}

/** Draws as `ios` for the rest of the test. */
function onIos(): void {
  const was = Platform.OS
  Platform.OS = 'ios'
  restore.push(() => {
    Platform.OS = was
  })
}

let selections: string[] = []

function Harness(
  props: Partial<PillTabsProps> & { initial?: string }
): React.ReactElement {
  const { initial = 'past', ...rest } = props
  const [selected, setSelected] = useState(initial)
  return (
    <PillTabs
      tabs={TABS}
      accessibilityLabel="When"
      {...rest}
      selected={selected}
      onSelect={id => {
        selections.push(id)
        setSelected(id)
      }}
    />
  )
}

async function render(element: React.ReactElement): Promise<HTMLElement> {
  selections = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

async function rerender(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}

function list(container: ParentNode = document): HTMLElement {
  return container.querySelector<HTMLElement>('[role="tablist"]')!
}

function targets(container: ParentNode = document): HTMLElement[] {
  return [
    ...list(container).querySelectorAll<HTMLElement>(
      '[role="tab"], [role="button"]'
    )
  ]
}

function pill(container: ParentNode = document): HTMLElement {
  return list(container).querySelector<HTMLElement>(
    '[data-testid="glass-tab-pill"]'
  )!
}

function tab(label: string): HTMLElement {
  return targets().find(n => n.getAttribute('aria-label') === label)!
}

type LayoutTarget = HTMLElement & {
  __reactLayoutHandler: (event: {
    nativeEvent: {
      layout: { x: number; y: number; width: number; height: number }
    }
  }) => void
}

/** Lays the targets out side by side at `WIDTHS`, as React Native would. */
async function layOut(
  container: ParentNode = document,
  widths = WIDTHS
): Promise<number[]> {
  const xs: number[] = []
  let x = 0
  await act(async () => {
    targets(container).forEach((target, at) => {
      xs.push(x)
      ;(target as LayoutTarget).__reactLayoutHandler({
        nativeEvent: { layout: { x, y: 0, width: widths[at], height: 48 } }
      })
      x += widths[at]
    })
  })
  // The pill's animated style is written on the next frame.
  await settle(50)
  return xs
}

async function settle(ms = 700): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

const side = tsBallpark.rem(0.875)
const pad = pillPadding(tsBallpark.rem(2.25))

/** Where the pill sits under the target at `x` of `width`. */
function under(x: number, width: number): [string, string] {
  return [`${x + side - pad}px`, `${width - 2 * side + 2 * pad}px`]
}

function placed(): [string, string] {
  return [pill().style.left, pill().style.width]
}

describe('the glass tab strip', function () {
  it('draws one pill under the selected tab, its label between the pill’s arcs', async function () {
    await render(<Harness />)
    const xs = await layOut()
    // The same layouts again change nothing.
    await layOut()
    expect(list().querySelectorAll('[data-testid="glass-tab-pill"]')).length(1)
    expect(placed()).deep.equals(under(xs[0], WIDTHS[0]))
    // The label box is the target less its sides, so the pill reaches past
    // it by the pill's padding on each side: half the pill's height.
    const labelWidth = WIDTHS[0] - 2 * side
    expect(parseFloat(pill().style.width) - labelWidth).equals(2 * pad)
    expect(pad).equals(tsBallpark.rem(2.25) / 2)
    const box = tab('Past').querySelector<HTMLElement>(
      '[data-testid="glass-tab-label"]'
    )!
    expect(getComputedStyle(box).height).equals(rem(2.25))
    expect(getComputedStyle(box).justifyContent).equals('center')
    expect(getComputedStyle(pill()).height).equals(rem(2.25))
    expect(getComputedStyle(pill()).top).equals(rem(0.375))
  })

  it('moves the pill to a tab that is chosen, and says which was chosen', async function () {
    await render(<Harness />)
    const xs = await layOut()
    await act(async () => {
      tab('All').click()
    })
    expect(selections).deep.equals(['all'])
    await settle()
    expect(placed()).deep.equals(under(xs[2], WIDTHS[2]))
    await act(async () => {
      tab('Upcoming').click()
    })
    await settle()
    expect(placed()).deep.equals(under(xs[1], WIDTHS[1]))
  })

  it('is a tablist whose selected tab alone is aria-selected, and its sizers are hidden', async function () {
    await render(<Harness />)
    expect(list().getAttribute('aria-label')).equals('When')
    const selected = targets().map(n => n.getAttribute('aria-selected'))
    expect(selected).deep.equals(['true', 'false', 'false'])
    for (const target of targets()) {
      const box = target.querySelector('[data-testid="glass-tab-label"]')!
      const hidden = box.querySelectorAll('[aria-hidden="true"]')
      expect(hidden).length(2)
    }
    await act(async () => {
      tab('Upcoming').click()
    })
    expect(targets().map(n => n.getAttribute('aria-selected'))).deep.equals([
      'false',
      'true',
      'false'
    ])
  })

  it('holds each tab at the wider of its two faces, whichever is selected', async function () {
    await render(<Harness />)
    const faces = (): string[][] =>
      targets().map(target => {
        const box = target.querySelector('[data-testid="glass-tab-label"]')!
        return [...box.querySelectorAll('[aria-hidden="true"]')].map(sizer => {
          const style = getComputedStyle(sizer)
          const text = getComputedStyle(sizer.querySelector('div[dir]')!)
          return [
            style.opacity,
            style.height,
            text.fontWeight,
            text.fontSize
          ].join(' ')
        })
      })
    const before = faces()
    // The selected face, semibold, above; the regular one under it, folded
    // to no height so the box takes the wider of the two.
    expect(before[0][0]).match(/^0 \S+ 600 14px$/)
    expect(before[0][1]).match(/^0 0px 400 14px$/)
    // Their text is drawn from an attribute, so a tab's text is its label
    // once; the label that shows sits over both, and does not set the width.
    const sizers = tab('Past').querySelectorAll('[data-glass-sizer]')
    expect(
      [...sizers].map(n => n.getAttribute('data-glass-sizer'))
    ).deep.equals(['Past', 'Past'])
    expect(tab('Past').textContent).equals('Past')
    const shown = tab('Past').querySelector<HTMLElement>(
      '[data-testid="glass-tab-label"] > div:last-child'
    )!
    expect(getComputedStyle(shown).position).equals('absolute')
    await act(async () => {
      tab('All').click()
    })
    expect(faces()).deep.equals(before)
  })

  it('draws small strips as a 32-point pill in 44-point targets that meet', async function () {
    await render(<Harness size="small" stacked />)
    const target = targets()[0]
    const box = target.querySelector<HTMLElement>(
      '[data-testid="glass-tab-label"]'
    )!
    expect(getComputedStyle(box).height).equals('32px')
    expect(getComputedStyle(pill()).height).equals('32px')
    // 6 above and below: a 44-point target.
    expect(getComputedStyle(target).paddingTop).equals('6px')
    expect(getComputedStyle(target).paddingBottom).equals('6px')
    // The pill's padding and 4 more on each side, and no gap between.
    expect(getComputedStyle(target).paddingLeft).equals('20px')
    const row = target.parentElement!
    expect(['', '0px']).includes(getComputedStyle(row).gap)
    expect(getComputedStyle(row).marginLeft).equals('-4px')
    const xs = await layOut(document, [60, 70, 50])
    expect(placed()).deep.equals([`${xs[0] + 20 - 16}px`, `${60 - 40 + 32}px`])
    const label = box.querySelector<HTMLElement>('div[dir]')!
    expect(getComputedStyle(label).fontSize).equals('12px')
  })

  it('narrows only the gaps of a dense strip, never the pill around a label', async function () {
    await render(<Harness dense />)
    const target = targets()[0]
    expect(getComputedStyle(target).paddingLeft).equals(rem(0.75))
    const box = target.querySelector<HTMLElement>(
      '[data-testid="glass-tab-label"]'
    )!
    expect(getComputedStyle(box).height).equals(rem(2.25))
    const xs = await layOut()
    const dense = tsBallpark.rem(0.75)
    expect(placed()).deep.equals([
      `${xs[0] + dense - pad}px`,
      `${WIDTHS[0] - 2 * dense + 2 * pad}px`
    ])
  })

  it('keeps its room above and below unless it is stacked', async function () {
    const container = await render(<Harness />)
    const content = list(container).firstElementChild as HTMLElement
    expect(getComputedStyle(content).paddingTop).equals(rem(0.25))
    await rerender(<Harness stacked />)
    expect(
      getComputedStyle(list(container).firstElementChild!).paddingTop
    ).equals('0px')
  })

  it('reaches the screen’s edges through the column’s padding, unless told not to', async function () {
    const container = await render(
      <ContentInsetContext.Provider value={{ left: 16, right: 20 }}>
        <Harness style={{ flexGrow: 0 }} />
      </ContentInsetContext.Provider>
    )
    const strip = list(container)
    expect(getComputedStyle(strip).marginLeft).equals('-16px')
    expect(getComputedStyle(strip).marginRight).equals('-20px')
    expect(getComputedStyle(strip).flexGrow).equals('0')
    expect(getComputedStyle(strip.firstElementChild!).paddingLeft).equals(
      '16px'
    )
    await rerender(
      <ContentInsetContext.Provider value={{ left: 16, right: 20 }}>
        <Harness bleed={false} />
      </ContentInsetContext.Provider>
    )
    expect(getComputedStyle(list(container)).marginLeft).not.equals('-16px')
    expect(
      getComputedStyle(list(container).firstElementChild!).paddingLeft
    ).equals(rem(0.25))
  })

  it('draws a badge and a live dot in the face that shows, and no aria-selected on a button', async function () {
    await render(
      <Harness
        tabs={[
          { id: 'videos', label: 'Videos', badge: '3' },
          { id: 'live', label: 'Live', role: 'button', live: true }
        ]}
        initial="videos"
      />
    )
    const dots = document.querySelectorAll('[data-testid="pill-live-dot"]')
    expect(dots).length(1)
    expect(
      dots[0].closest('[role="button"]')!.getAttribute('aria-label')
    ).equals('Live')
    expect(getComputedStyle(dots[0]).backgroundColor).equals(
      hexToRgb(tsBallpark.liveColor)
    )
    const shown = tab('Videos').querySelector<HTMLElement>(
      '[data-testid="glass-tab-label"] > div:last-child'
    )!
    expect(shown.textContent).equals('Videos3')
    const button = tab('Live')
    expect(button.getAttribute('aria-selected')).equals(null)
    await act(async () => {
      button.click()
    })
    expect(selections).deep.equals(['live'])
  })

  it('scrolls to centre the selected tab in a strip too narrow for its tabs', async function () {
    const scrolled: Array<{ left?: number }> = []
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scroll')
    Object.defineProperty(HTMLElement.prototype, 'scroll', {
      configurable: true,
      writable: true,
      value(options?: ScrollToOptions | number) {
        if (typeof options === 'object') scrolled.push({ left: options.left })
      }
    })
    restore.push(() => {
      if (own != null)
        Object.defineProperty(HTMLElement.prototype, 'scroll', own)
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scroll
    })
    await render(<Harness />)
    await act(async () => {
      ;(list() as LayoutTarget).__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 56 } }
      })
    })
    await layOut()
    await act(async () => {
      tab('All').click()
    })
    // The third tab's middle, 200 + 30, less half the strip.
    expect(scrolled.at(-1)).deep.equals({ left: 180 })
  })

  it('starts a strip that replaces one with the same tabs where that one’s pill was, and later ones in place', async function () {
    onIos()
    await render(<Harness initial="all" />)
    await layOut()
    await settle(500)
    await act(async () => {
      root?.unmount()
    })
    // Another strip with the same tabs, straight after: its pill travels
    // from where the last one was, so it is lifted on the way.
    await render(<Harness initial="past" />)
    await layOut()
    const tint = (): unknown => glassOf(pill())?.tint
    expect(tint(), 'tint 1').equals(`${tsBallpark.pillActiveBackground}33`)
    await settle()
    expect(tint(), 'tint 2').equals(`${tsBallpark.pillActiveBackground}8C`)
    expect(placed()).deep.equals(under(0, WIDTHS[0]))
    await act(async () => {
      root?.unmount()
    })
    // Past the handover's 1.5 seconds, a strip starts in place, at rest.
    const now = Date.now
    Date.now = () => now() + 2000
    restore.push(() => {
      Date.now = now
    })
    await render(<Harness initial="all" />)
    await layOut()
    expect(tint(), 'tint 3').equals(`${tsBallpark.pillActiveBackground}8C`)
    expect(placed()).deep.equals(under(200, WIDTHS[2]))
  })

  it('lifts the pill while the selected tab is held, and settles it after', async function () {
    onIos()
    await render(<Harness />)
    await layOut()
    const press = (key: 'onPressIn' | 'onPressOut', label: string): void => {
      ;(propsWith(tab(label), key)[key] as () => void)()
    }
    await act(async () => {
      press('onPressIn', 'Past')
    })
    await settle(300)
    expect(pill().style.transform).equals('scale(1.12)')
    expect(glassOf(pill())?.tint).equals(`${tsBallpark.pillActiveBackground}33`)
    await act(async () => {
      press('onPressOut', 'Past')
    })
    await settle(400)
    expect(pill().style.transform).equals('scale(1)')
    expect(glassOf(pill())?.tint).equals(`${tsBallpark.pillActiveBackground}8C`)
    // Holding a tab that is not selected leaves the pill where it is.
    await act(async () => {
      press('onPressIn', 'All')
    })
    expect(glassOf(pill())?.tint).equals(`${tsBallpark.pillActiveBackground}8C`)
  })

  it('is interactive Liquid Glass tinted the strip’s green on iOS, and a filled green pill elsewhere', async function () {
    await render(<Harness />)
    expect(glassOf(pill())).equals(undefined)
    expect(getComputedStyle(pill()).backgroundColor).equals(
      hexToRgb(tsBallpark.pillActiveBackground)
    )
    await act(async () => {
      root?.unmount()
    })
    onIos()
    await render(<Harness />)
    const glass = glassOf(pill())!
    expect(glass.interactive).equals(true)
    expect(glass.tint).equals(`${tsBallpark.pillActiveBackground}8C`)
    expect(glass.radius).equals(tsBallpark.rem(2.25) / 2)
    // On a phone the sizers are text the phone measures.
    const sizers = tab('Past').querySelectorAll('[aria-hidden="true"] div[dir]')
    expect([...sizers].map(n => n.textContent)).deep.equals(['Past', 'Past'])
    expect(getComputedStyle(pill()).backgroundColor).not.equals(
      hexToRgb(tsBallpark.pillActiveBackground)
    )
    // The label colours are the filled pill's, on every platform.
    const label = (name: string): string =>
      getComputedStyle(
        tab(name).querySelector(
          '[data-testid="glass-tab-label"] > div:last-child div[dir]'
        )!
      ).color
    expect(label('Past')).equals(hexToRgb(tsBallpark.pillActiveTextColor))
    expect(label('All')).equals(hexToRgb(tsBallpark.pillTextColor))
  })
})
