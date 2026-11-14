import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PixelRatio } from 'react-native'

import type { ScreenRect } from '../field/catcherBounds'
import { ThemeProvider } from '../theme/ThemeContext'
import type { AnnouncerEntry } from './announcerLines'
import {
  ANNOUNCER_LINE_HEIGHT,
  ANNOUNCER_LINES,
  CARD_BORDER,
  CARD_CHROME,
  CARD_GAP,
  CARD_PADDING,
  cardFontScale,
  cardHeightOf,
  DETAIL_LINE_HEIGHT,
  detailStripHeight,
  estimatedLineHeights,
  MAX_FONT_SCALE,
  ReplayDetailStrip,
  ReplayPlayCard,
  type ReplayPlayCardProps,
  useCardLineHeights
} from './ReplayPlayCard'

interface Fiber {
  memoizedProps?: Record<string, unknown>
  return?: Fiber | null
}

const CATCHER: ScreenRect = { x: 190, y: 300, width: 22, height: 30 }

const entries = (count: number): AnnouncerEntry[] =>
  Array.from({ length: count }, (_, key) => ({ key, text: `Line ${key}.` }))

describe('the replay play card', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
  })

  const base: ReplayPlayCardProps = {
    lines: entries(1),
    detail: '0–0 · 0 outs',
    catcher: CATCHER,
    width: 402,
    height: 874
  }

  async function render(props: Partial<ReplayPlayCardProps>): Promise<void> {
    if (host == null) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ReplayPlayCard {...base} {...props} />
        </ThemeProvider>
      )
    })
  }

  const node = (testID: string): HTMLElement | null =>
    host!.querySelector<HTMLElement>(`[data-testid="${testID}"]`)

  /** The props of the outermost component given `testID`. */
  function propsOf(testID: string): Record<string, unknown> {
    const dom = node(testID)!
    const key = Object.keys(dom).find(name => name.startsWith('__reactFiber'))!
    let fiber = (dom as unknown as Record<string, Fiber>)[key] as
      Fiber | null | undefined
    let found: Record<string, unknown> | undefined
    for (; fiber != null; fiber = fiber.return)
      if (fiber.memoizedProps?.testID === testID) found = fiber.memoizedProps
    return found!
  }

  for (const count of [0, 1, 3, 6])
    it(`holds the words to three lines, 60 points, with ${count} of them`, async function () {
      await render({ lines: entries(count) })
      const words = node('replay-play-card-words')!
      expect(ANNOUNCER_LINES * ANNOUNCER_LINE_HEIGHT).equals(60)
      expect(words.style.height).equals('60px')
      expect(words.textContent).equals(
        entries(count)
          .map(entry => entry.text)
          .join('')
      )
      const props = propsOf('replay-play-card-words')
      expect(props.scrollEnabled).equals(false)
      expect(props.pointerEvents).equals('none')
      expect(props.contentContainerStyle).deep.include({
        flexGrow: 1,
        justifyContent: 'flex-end'
      })
    })

  it('scrolls a new sentence in, animated, to the end', async function () {
    await render({ lines: entries(3) })
    const words = node('replay-play-card-words')!
    const scrolls: ScrollToOptions[] = []
    Object.defineProperty(words, 'scrollHeight', {
      configurable: true,
      value: 80
    })
    words.scroll = ((options: ScrollToOptions) => {
      scrolls.push(options)
    }) as typeof words.scroll
    await render({ lines: entries(4) })
    // The new sentence scrolls in itself: the primary path.
    expect(scrolls).deep.equals([{ top: 80, left: 0, behavior: 'smooth' }])
    // Drawn again with the same newest sentence, nothing more.
    await render({ lines: entries(4), detail: '1–0 · 0 outs' })
    expect(scrolls).length(1)
    // Growth as the page lays it out goes to the same end, retargeting that
    // one smooth scroll; it is what keeps a sentence that wraps, or the
    // area resized, at the end.
    await act(async () => {
      ;(propsOf('replay-play-card-words').onContentSizeChange as Function)(
        300,
        80
      )
    })
    expect(scrolls).deep.equals([
      { top: 80, left: 0, behavior: 'smooth' },
      { top: 80, left: 0, behavior: 'smooth' }
    ])
  })

  it('scrolls each new sentence to the end, even when the browser moved the words up and their size did not change', async function () {
    await render({ lines: entries(6) })
    const words = node('replay-play-card-words')!
    const scrolls: ScrollToOptions[] = []
    Object.defineProperty(words, 'scrollHeight', {
      configurable: true,
      value: 120
    })
    words.scroll = ((options: ScrollToOptions) => {
      scrolls.push(options)
    }) as typeof words.scroll
    // The seventh line trims the first: the content above shrinks, and the
    // browser moves the offset up, which no reader did.
    expect(propsOf('replay-play-card-words').onScroll).equals(undefined)
    expect(propsOf('replay-play-card-words').onScrollBeginDrag).equals(
      undefined
    )
    await act(async () => {
      words.scrollTop = 40
      words.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    })
    // The new line is as tall as the one it pushed out: the content's size
    // does not change, and the new sentence still scrolls to the end.
    await render({ lines: entries(7).slice(1) })
    expect(scrolls).deep.equals([{ top: 120, left: 0, behavior: 'smooth' }])
  })

  it('marks the newest sentence, fading it with lineOpacity, and writes the detail below', async function () {
    await render({ lines: entries(3), lineOpacity: 0.4 })
    const line = node('replay-play-card-line')!
    expect(line.textContent).equals('Line 2.')
    expect(line.style.opacity).equals('0.4')
    expect(
      host!.querySelectorAll('[data-testid="replay-play-card-line"]')
    ).length(1)
    const older = [...node('replay-play-card-words')!.querySelectorAll('*')]
      .filter(item => item.textContent === 'Line 0.')
      .at(-1) as HTMLElement
    expect(older.style.opacity).equals('1')
    const detail = node('replay-play-card-detail')!
    expect(detail.textContent).equals('0–0 · 0 outs')
    const words = node('replay-play-card-words')!
    expect(
      words.compareDocumentPosition(detail) &
        window.Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    expect(words.contains(detail)).equals(false)
    await render({ lines: entries(1), detail: '' })
    expect(node('replay-play-card-detail')).equals(null)
    expect(node('replay-play-card-line')!.style.opacity).equals('1')
  })

  it('hangs below the catcher, kept on the screen by its height', async function () {
    await render({})
    // Below the nameplate, 300 + 30 + 24, and half a rem more: 362.
    const card = node('replay-play-card')!
    expect(card.style.position).equals('absolute')
    expect(card.style.top).equals('362px')
    // Held 12 above the screen's bottom, by the card's height for its lines.
    await render({ height: 420 })
    expect(card.style.top).equals(
      `${420 - 12 - cardHeightOf(3, estimatedLineHeights(1))}px`
    )
    await render({ height: 400, lineCount: 1 })
    expect(card.style.top).equals(
      `${400 - 12 - cardHeightOf(1, estimatedLineHeights(1))}px`
    )
  })

  it('counts its chrome, padding, border and the gap, and its lines', async function () {
    expect(CARD_CHROME).equals(2 * 8 + 2 * 2 + 2)
    expect(cardHeightOf(3, estimatedLineHeights(1))).equals(
      CARD_CHROME + DETAIL_LINE_HEIGHT + 60
    )
    await render({})
    expect(propsOf('replay-play-card').style).deep.include({
      paddingVertical: CARD_PADDING,
      borderWidth: CARD_BORDER,
      gap: CARD_GAP
    })
    const detail = node('replay-play-card-detail')!
    expect(detail.style.lineHeight).equals(`${DETAIL_LINE_HEIGHT}px`)
    expect(propsOf('replay-play-card-detail').numberOfLines).equals(1)
    // With no detail, its line is still kept, so the card's height holds.
    await render({ detail: '' })
    const words = node('replay-play-card-words')!
    const spacer = words.nextElementSibling as HTMLElement
    expect(spacer.style.height).equals(`${DETAIL_LINE_HEIGHT}px`)
  })

  for (const lineCount of [2, 1])
    it(`shows ${lineCount} line${lineCount === 1 ? '' : 's'} of words where only that fits, still following the tail`, async function () {
      await render({ lines: entries(3), lineCount })
      const words = node('replay-play-card-words')!
      expect(words.style.height).equals(
        `${lineCount * ANNOUNCER_LINE_HEIGHT}px`
      )
      const scrolls: ScrollToOptions[] = []
      Object.defineProperty(words, 'scrollHeight', {
        configurable: true,
        value: 80
      })
      words.scroll = ((options: ScrollToOptions) => {
        scrolls.push(options)
      }) as typeof words.scroll
      await render({ lines: entries(4), lineCount })
      expect(scrolls).deep.equals([{ top: 80, left: 0, behavior: 'smooth' }])
      expect(node('replay-play-card-line')!.textContent).equals('Line 3.')
      expect(
        propsOf('replay-play-card-words').contentContainerStyle
      ).deep.include({
        flexGrow: 1,
        justifyContent: 'flex-end'
      })
    })

  it('waits for the catcher, unless laid out in a column', async function () {
    await render({ catcher: null })
    expect(node('replay-play-card')).equals(null)
    await render({ catcher: null, placement: 'column', width: 360 })
    const card = node('replay-play-card')!
    expect(card.style.position).not.equals('absolute')
    expect(card.style.top).equals('')
    expect(card.style.marginLeft).equals('12px')
    expect(card.style.marginRight).equals('12px')
    expect(node('replay-play-card-words')!.style.height).equals('60px')
  })

  describe('at a larger text size', function () {
    // The system's text size, put back after each case.
    const getFontScale = Object.getOwnPropertyDescriptor(
      PixelRatio,
      'getFontScale'
    )!
    afterEach(function () {
      Object.defineProperty(PixelRatio, 'getFontScale', getFontScale)
    })

    it('scales its lines by the system text size, up to MAX_FONT_SCALE', async function () {
      PixelRatio.getFontScale = () => 1.5
      expect(cardFontScale()).equals(1.5)
      await render({ lines: entries(3) })
      expect(node('replay-play-card-words')!.style.height).equals(
        `${ANNOUNCER_LINES * 20 * 1.5}px`
      )
      // Its texts stop growing where its arithmetic does.
      expect(MAX_FONT_SCALE).equals(2)
      expect(propsOf('replay-play-card-line').maxFontSizeMultiplier).equals(
        MAX_FONT_SCALE
      )
      expect(propsOf('replay-play-card-detail').maxFontSizeMultiplier).equals(
        MAX_FONT_SCALE
      )
      expect(cardHeightOf(3, estimatedLineHeights(1.5))).equals(
        CARD_CHROME + (DETAIL_LINE_HEIGHT + 60) * 1.5
      )
      // Kept on the screen by its height at that size.
      await render({ lines: entries(3), height: 420 })
      expect(node('replay-play-card')!.style.top).equals(
        `${420 - 12 - cardHeightOf(3, estimatedLineHeights(1.5))}px`
      )
      // An empty detail keeps its scaled line.
      await render({ lines: entries(1), detail: '', lineCount: 2 })
      const words = node('replay-play-card-words')!
      expect(words.style.height).equals(`${2 * 20 * 1.5}px`)
      expect((words.nextElementSibling as HTMLElement).style.height).equals(
        `${DETAIL_LINE_HEIGHT * 1.5}px`
      )
      PixelRatio.getFontScale = () => 3.1
      expect(cardFontScale()).equals(MAX_FONT_SCALE)
      // Given heights win over the system's scale.
      await render({ lines: entries(1), lineHeights: estimatedLineHeights(1) })
      expect(node('replay-play-card-words')!.style.height).equals('60px')
    })
  })

  describe('measured line heights', function () {
    const getFontScale = Object.getOwnPropertyDescriptor(
      PixelRatio,
      'getFontScale'
    )!
    afterEach(function () {
      Object.defineProperty(PixelRatio, 'getFontScale', getFontScale)
    })

    /** The card, drawn with the heights its probes measure. */
    function Measured(props: Partial<ReplayPlayCardProps>): React.ReactElement {
      const { heights, probes } = useCardLineHeights()
      renders += 1
      return (
        <>
          {probes}
          <ReplayPlayCard {...base} {...props} lineHeights={heights} />
        </>
      )
    }
    let renders = 0

    async function measured(
      props: Partial<ReplayPlayCardProps>
    ): Promise<void> {
      if (host == null) {
        host = document.createElement('div')
        document.body.append(host)
        root = createRoot(host)
      }
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <Measured {...props} />
          </ThemeProvider>
        )
      })
    }

    const layout = async (part: string, height: number): Promise<void> => {
      const onLayout = propsOf(`replay-line-probe-${part}`).onLayout as (
        event: unknown
      ) => void
      await act(async () => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 20, height } } })
      })
    }
    const heightOf = (testID: string): number =>
      Number.parseFloat(node(testID)!.style.height)

    it('sizes its words by a probe that measures 23.6 at 1.3×, the estimate until then', async function () {
      PixelRatio.getFontScale = () => 1.3
      await measured({ lines: entries(3), detail: '', height: 420 })
      const words = node('replay-play-card-words')!
      // Before the probes are laid out, the scale's estimate.
      expect(heightOf('replay-play-card-words')).closeTo(3 * 26, 1e-9)
      expect(
        Number.parseFloat(
          (words.nextElementSibling as HTMLElement).style.height
        )
      ).closeTo(16 * 1.3, 1e-9)
      await layout('words', 23.6)
      await layout('detail', 19.2)
      const heights = { words: 23.6, detail: 19.2 }
      expect(heightOf('replay-play-card-words')).closeTo(3 * 23.6, 1e-9)
      expect(
        Number.parseFloat(
          (words.nextElementSibling as HTMLElement).style.height
        )
      ).closeTo(19.2, 1e-9)
      // Kept on the screen by its measured height.
      expect(Number.parseFloat(node('replay-play-card')!.style.top)).closeTo(
        420 - 12 - cardHeightOf(3, heights),
        1e-9
      )
      expect(cardHeightOf(3, heights)).closeTo(CARD_CHROME + 19.2 + 70.8, 1e-9)
      await measured({ lines: entries(3), lineCount: 2 })
      expect(heightOf('replay-play-card-words')).closeTo(2 * 23.6, 1e-9)
      // The same height again, or none at all, draws nothing new.
      const before = renders
      await layout('words', 23.6)
      await layout('words', 0)
      expect(renders).equals(before)
      expect(heightOf('replay-play-card-words')).closeTo(2 * 23.6, 1e-9)
    })

    it('measures one hidden line in each of the card’s line styles', async function () {
      await measured({ lines: entries(1) })
      for (const [part, style] of [
        ['words', 'replay-play-card-line'],
        ['detail', 'replay-play-card-detail']
      ] as const) {
        const probe = node(`replay-line-probe-${part}`)!
        const text = node(style)!
        expect(probe.textContent).equals('Ag')
        expect(propsOf(`replay-line-probe-${part}`)).deep.include({
          numberOfLines: 1,
          maxFontSizeMultiplier: MAX_FONT_SCALE
        })
        for (const key of ['fontFamily', 'fontSize', 'lineHeight'] as const)
          expect(probe.style[key], key).equals(text.style[key])
        expect(probe.style.position).equals('absolute')
        const holder = probe.parentElement!
        expect(holder.style.opacity).equals('0')
        expect(holder.style.position).equals('absolute')
        expect(holder.getAttribute('aria-hidden')).equals('true')
        expect(holder).equals(node('replay-line-probes'))
        expect(propsOf('replay-line-probes')).deep.include({
          pointerEvents: 'none',
          accessibilityElementsHidden: true,
          importantForAccessibility: 'no-hide-descendants'
        })
      }
      // A browser draws them at their style's heights, as at 1×.
      expect(estimatedLineHeights(1)).deep.equals({
        words: ANNOUNCER_LINE_HEIGHT,
        detail: DETAIL_LINE_HEIGHT
      })
    })
  })

  it('writes the detail alone in a strip, in the card’s style', async function () {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ReplayDetailStrip detail="Announcer unavailable" />
        </ThemeProvider>
      )
    })
    expect(node('replay-deck-detail-text')!.textContent).equals(
      'Announcer unavailable'
    )
    expect(propsOf('replay-deck-detail').style).deep.include({
      borderWidth: CARD_BORDER,
      paddingVertical: 4
    })
    expect(propsOf('replay-deck-detail-text').maxFontSizeMultiplier).equals(
      MAX_FONT_SCALE
    )
    expect(node('replay-deck-detail-text')!.style.lineHeight).equals(
      `${DETAIL_LINE_HEIGHT}px`
    )
    expect(detailStripHeight(estimatedLineHeights(1))).equals(
      2 * 4 + 2 * 2 + 16
    )
    expect(detailStripHeight(estimatedLineHeights(2))).equals(
      2 * 4 + 2 * 2 + 32
    )
  })
})
