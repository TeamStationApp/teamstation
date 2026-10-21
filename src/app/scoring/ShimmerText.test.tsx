import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo } from 'react-native'

import { shimmerFits, shimmerPeak, ShimmerText } from './ShimmerText'

let root: Root | undefined
const render = async (): Promise<HTMLElement> => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ShimmerText
        testID="shimmer"
        accessibilityLabel="Share it"
        text="Share it"
        color="#e2e8f0"
        highlight="#6ee7b7"
        style={{ fontWeight: '700' }}
      />
    )
  })
  return host.querySelector<HTMLElement>('[data-testid="shimmer"]')!
}
/** Reports a width to a node's onLayout, as react-native-web would. */
const layout = async (node: Element, width: number): Promise<void> => {
  await act(async () => {
    ;(
      node as HTMLElement & { __reactLayoutHandler: (event: unknown) => void }
    ).__reactLayoutHandler({
      nativeEvent: { layout: { x: 0, y: 0, width, height: 16 } }
    })
  })
}
const measured = async (
  shimmer: HTMLElement,
  room: number,
  natural: number
): Promise<void> => {
  await layout(shimmer, room)
  await layout(
    shimmer.querySelector('[data-testid="shimmer measure"]')!,
    natural
  )
}
/** What shows: the characters' row or the still line, after the measure. */
const shown = (shimmer: HTMLElement): HTMLElement =>
  shimmer.children[1] as HTMLElement

describe('shimmering text', function () {
  const reduced =
    AccessibilityInfo.isReduceMotionEnabled.bind(AccessibilityInfo)
  afterEach(async () => {
    AccessibilityInfo.isReduceMotionEnabled = reduced
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  it('sweeps left to right, entering before the first character and leaving after the last', function () {
    const peaks = Array.from({ length: 8 }, (_, index) => shimmerPeak(index, 8))
    for (let index = 1; index < peaks.length; index++)
      expect(peaks[index] > peaks[index - 1]).equals(true)
    expect(peaks[0] > 0).equals(true)
    expect(peaks[7] < 1).equals(true)
  })

  it('fits only once both widths are known and the line is no wider than its room', function () {
    expect(shimmerFits(undefined, 50)).equals(false)
    expect(shimmerFits(100, undefined)).equals(false)
    expect(shimmerFits(100, 100.4)).equals(true)
    expect(shimmerFits(100, 101)).equals(false)
  })

  it('draws each character on its own once the line is found to fit', async function () {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    const shimmer = await render()
    // Unmeasured, it is the still line.
    expect(shown(shimmer).children).has.length(0)
    await measured(shimmer, 200, 60)
    expect(shown(shimmer).getAttribute('aria-label')).equals('Share it')
    expect(shown(shimmer).textContent).equals('Share it')
    expect(shown(shimmer).children).has.length(8)
  })

  it('measures the characters as it draws them, and lays them out left to right', async function () {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    const shimmer = await render()
    const measure = shimmer.querySelector<HTMLElement>(
      '[data-testid="shimmer measure"]'
    )!
    // One text per character, as the sweep draws them, not one joined line.
    expect(measure.children).has.length(8)
    expect(getComputedStyle(measure).direction).equals('ltr')
    await measured(shimmer, 200, 60)
    expect(getComputedStyle(shown(shimmer)).direction).equals('ltr')
  })

  it('holds still when the characters come out a little wider than the room', async function () {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    const shimmer = await render()
    // Separate characters round up apart: 2pt over is too wide to sweep.
    await measured(shimmer, 100, 102)
    expect(shown(shimmer).children).has.length(0)
    expect(getComputedStyle(shown(shimmer)).textOverflow).equals('ellipsis')
  })

  it('ellipsizes one still line when the text is wider than its room', async function () {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    const shimmer = await render()
    await measured(shimmer, 40, 60)
    const line = shown(shimmer)
    expect(line.children).has.length(0)
    expect(line.textContent).equals('Share it')
    expect(getComputedStyle(line).whiteSpace).equals('nowrap')
    expect(getComputedStyle(line).textOverflow).equals('ellipsis')
  })

  it('keeps one still line with Reduce Motion on', async function () {
    AccessibilityInfo.isReduceMotionEnabled = async () => true
    const shimmer = await render()
    await measured(shimmer, 200, 60)
    const line = shown(shimmer)
    expect(line.children).has.length(0)
    expect(line.getAttribute('aria-label')).equals('Share it')
    expect(getComputedStyle(line).color).equals('rgb(226, 232, 240)')
  })
})
