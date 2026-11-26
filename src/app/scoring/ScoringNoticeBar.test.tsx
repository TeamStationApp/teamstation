import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Animated, Platform, Text } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import type { ScoringNotice } from './scoringNotice'
import { ScoringNoticeBar } from './ScoringNoticeBar'
import { ScoringSheet } from './ScoringSheet'
import { replacedReport } from './sidesSwapped'

const report = (text: string): ScoringNotice => ({ kind: 'report', text })
const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map(start => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

describe('the scoring notice bar', function () {
  let host: HTMLDivElement
  let root: Root
  let reduced: boolean
  const draw = async (
    notice: ScoringNotice | null,
    bottom = 0,
    compact?: string
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ScoringNoticeBar
            reducedMotion={reduced}
            frame={{
              stripTop: 568 - 40 - bottom,
              stripHeight: 40 + bottom,
              fieldWidth: 320
            }}
            notice={notice}
            compact={compact}
            held={
              notice?.kind === 'held'
                ? {
                    state: 'dead',
                    text: notice.text,
                    retry: async () => undefined,
                    discard: async () => true
                  }
                : undefined
            }
            onSettled={() => undefined}
          />
        </ThemeProvider>
      )
    })
  }
  const bar = (): HTMLElement | null =>
    host.querySelector('[data-testid="scoringNotice"]')
  const label = (): HTMLElement =>
    host.querySelector('[aria-label]:not([role="button"])')!
  beforeEach(() => {
    reduced = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })

  for (const inset of [0, 20, 34])
    it(`fills the reserved strip through the ${inset} point bottom inset`, async () => {
      await draw(report('Saving…'), inset)
      const box = bar()!
      expect([
        box.style.left,
        box.style.width,
        box.style.top,
        box.style.height
      ]).deep.equals(['0px', '320px', `${528 - inset}px`, `${40 + inset}px`])
      expect(getComputedStyle(box).pointerEvents).equals('none')
      expect(box.style.backgroundColor).equals('rgb(255, 211, 77)')
      expect(box.getAttribute('aria-live')).equals('polite')
      expect(label().parentElement!.style.height).equals('40px')
      expect(label().dataset.testid).equals('scoringSaveStatus')
      expect(box.querySelector('[role="button"]')).equals(null)
      await draw(null)
      expect(host.textContent).equals('')
    })
  it('has AA contrast in both themes', () => {
    for (const theme of [tsBallpark, tsDark])
      expect(
        (luminance(theme.scoringNoticeFill) + 0.05) /
          (luminance(theme.scoringNoticeText) + 0.05)
      ).at.least(4.5)
  })
  it('keeps the report still when the text changes and slides only on entry and exit', async () => {
    reduced = false
    const timing = Animated.timing
    const moves: number[] = []
    const observedTiming: typeof Animated.timing = (value, config) => {
      moves.push(Number(config.toValue))
      expect(config.duration).equals(200)
      return timing(value, { ...config, duration: 1 })
    }
    Object.defineProperty(Animated, 'timing', {
      configurable: true,
      value: observedTiming
    })
    try {
      await draw(null)
      await draw(report('First report'))
      await draw(report('Second report'))
      expect(label().textContent).equals('Second report')
      await draw(null)
      expect(moves).deep.equals([0, 1])
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
      })
      expect(host.textContent).equals('')
    } finally {
      Object.defineProperty(Animated, 'timing', {
        configurable: true,
        value: timing
      })
    }
  })
  it('shows full details and the discard and retry choices from the held button', async () => {
    await draw({ kind: 'held', text: 'Not sent: Refused lineup' })
    expect(bar()).equals(null)
    const button = host.querySelector<HTMLElement>(
      '[data-testid="heldGameMessage"]'
    )!
    await act(async () => {
      button.click()
    })
    const modal = document.querySelector('[aria-modal="true"]')!
    expect(modal.textContent).includes('Not sent: Refused lineup')
    expect(modal.textContent).includes('Try Again')
    expect(modal.textContent).includes("Use Server's Copy")
  })

  it('fits at 13, 12 or 11 points and summarizes a detail that still overflows, retaining its accessible label', async () => {
    const prototype = HTMLElement.prototype
    const old = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight')
    let largest = 13
    Object.defineProperty(prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.fontSize) > largest ? 48 : 32
      }
    })
    try {
      for (largest of [13, 12, 11, 10]) {
        const full = 'Not saved: ' + 'x'.repeat(350) + largest
        await draw(report(full))
        expect(label().style.fontSize).equals(
          `${largest < 11 ? 13 : largest}px`
        )
        expect(label().getAttribute('aria-label')).equals(full)
        expect(label().textContent).equals(
          largest < 11 ? 'The server could not save these changes.' : full
        )
      }
    } finally {
      if (old != null) Object.defineProperty(prototype, 'scrollHeight', old)
      else Reflect.deleteProperty(prototype, 'scrollHeight')
    }
  })
  it('measures native overflow without dropping below 11 and keeps a complete actionable summary', async () => {
    const os = Platform.OS
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    const full = 'Not sent: ' + 'x'.repeat(350)
    try {
      await draw({ kind: 'held', text: full })
      for (const size of [13, 12, 11]) {
        interface Fiber {
          memoizedProps?: {
            style?: { fontSize?: number }
            onTextLayout?: (event: {
              nativeEvent: { lines: Array<{ width: number }> }
            }) => void
          }
          sibling?: Fiber
          child?: Fiber
          stateNode?: { current: Fiber }
        }
        const key = Object.keys(host).find(k =>
          k.startsWith('__reactContainer$')
        )!
        const current = (host as unknown as Record<string, Fiber>)[key]
          .stateNode!.current
        const find = (node?: Fiber): Fiber | undefined =>
          node == null
            ? undefined
            : node.memoizedProps?.onTextLayout != null
              ? node
              : (find(node.child) ?? find(node.sibling))
        const measuring = find(current)?.memoizedProps
        expect(measuring?.style?.fontSize).equals(size)
        await act(async () => {
          measuring!.onTextLayout!({
            nativeEvent: {
              lines: [{ width: 304 }, { width: 304 }, { width: 304 }]
            }
          })
        })
      }
      expect(
        host.querySelector('[aria-label="' + full + '"]')?.textContent
      ).equals('Edits not sent. Tap for details.')
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: os })
    }
  })
  it('displays concise counts while announcing the complete replacement report', async () => {
    for (const [lost, unsure, summary] of [
      [0, 0, 'Home and away were swapped and the game was reset.'],
      [1, 0, 'Reset and swapped. 1 edit lost.'],
      [2, 1, 'Reset and swapped. 2 edits lost. 1 unconfirmed.'],
      [0, 2, 'Reset and swapped. 2 unconfirmed.']
    ] as const) {
      const { text, compact } = replacedReport(
        { reset: true, swapped: true },
        lost,
        unsure
      )
      await draw(report(text), 0, compact)
      expect(label().textContent).equals(summary)
      expect(label().getAttribute('aria-label')).equals(text)
    }
  })

  it('places the optional notice after the sheet content within the modal window', async () => {
    for (const visible of [true, false]) {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <ScoringSheet
              title="Set Team Rosters"
              onClose={() => undefined}
              notice={
                visible ? <Text testID="notice-slot">Report</Text> : undefined
              }
            >
              <Text>Roster editor</Text>
            </ScoringSheet>
          </ThemeProvider>
        )
      })
      const modal = document.querySelector('[aria-modal="true"]')!
      const slot = modal.querySelector('[data-testid="notice-slot"]')
      expect(slot != null).equals(visible)
      if (slot != null)
        expect(slot.parentElement?.lastElementChild).equals(slot)
    }
  })
})
