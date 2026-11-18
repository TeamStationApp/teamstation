import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import {
  LocationPill,
  locationPillGeometry,
  suggestedSlop
} from './LocationPill'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const px = (value: string): number => Number(value.replace('px', ''))

const hex = (color: string): string => {
  const [r, g, b] = color.match(/\d+/g)!.map(Number)
  return (
    '#' +
    [r, g, b]
      .map(v => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

describe('the location pill', function () {
  it('puts a circle 0.6 of the height across on the midline, half the height in from the right', function () {
    const geometry = locationPillGeometry(20, 1)
    expect(geometry.radius).closeTo(6, 1e-9)
    expect(geometry.centreInset).equals(10)
    expect(geometry.centreY).equals(10)
    // The X spans 40% of the diameter.
    expect(geometry.markSpan).closeTo(4.8, 1e-9)
    expect(geometry.target).equals(44)
  })

  it('scales with the height, never draws the X thinner than 1.5, and never a target under 44', function () {
    const big = locationPillGeometry(60, 3)
    expect(big.radius).closeTo(18, 1e-9)
    expect(big.markSpan).closeTo(14.4, 1e-9)
    expect(big.markStroke).equals(3)
    expect(locationPillGeometry(20, 1).markStroke).equals(1.5)
    // A pill big enough for a wider circle takes the circle as its target.
    expect(locationPillGeometry(200).target).equals(120)
  })

  it('draws the kind pill’s size and colors with a gray circle and a round-capped white X, and only the X removes it', async function () {
    let removed = 0
    await mount(
      <LocationPill
        label="San Diego, CA"
        onRemove={() => {
          removed++
        }}
      />
    )
    const pill = byTestId('location-pill')!
    expect(pill.textContent).equals('San Diego, CA')
    expect(pill.style.height).equals('20px')
    const style = window.getComputedStyle(pill)
    expect(hex(style.backgroundColor)).equals(tsBallpark.neutralBadgeBackground)
    const label =
      pill.querySelector<HTMLElement>('[dir], div[dir="auto"]') ??
      (pill.firstElementChild as HTMLElement)
    const labelStyle = window.getComputedStyle(label)
    expect(hex(labelStyle.color)).equals(tsBallpark.neutralBadgeTextColor)
    expect(labelStyle.fontSize).equals('12px')

    const svg = byTestId('location-pill-mark')!
    const circle = svg.querySelector('circle')!
    expect(Number(circle.getAttribute('r'))).closeTo(6, 1e-9)
    expect(circle.getAttribute('fill')).equals(tsBallpark.pillCloseColor)
    expect(tsBallpark.pillCloseColor).equals('#4E4A42')
    const marks = [...svg.querySelectorAll('line')]
    expect(marks).length(2)
    for (const mark of marks) {
      expect(mark.getAttribute('stroke')).equals(tsBallpark.pillCloseMarkColor)
      expect(mark.getAttribute('stroke-width')).equals('1.5')
      expect(mark.getAttribute('stroke-linecap')).equals('round')
      const span = Math.abs(
        Number(mark.getAttribute('x2')) - Number(mark.getAttribute('x1'))
      )
      expect(span).closeTo(4.8, 1e-9)
    }
    // The circle's box: its centre 10 in from the right and 10 down.
    const box = svg.parentElement!
    expect(px(box.style.right) + px(box.style.width) / 2).closeTo(10, 1e-9)
    expect(px(box.style.top) + px(box.style.height) / 2).closeTo(10, 1e-9)

    // The X's target: 44 square, centred on the circle.
    const remove = byTestId('location-pill-remove')!
    expect(remove.getAttribute('aria-label')).equals('Remove San Diego, CA')
    expect(remove.style.width).equals('44px')
    expect(remove.style.height).equals('44px')
    expect(px(remove.style.right) + 22).closeTo(10, 1e-9)
    expect(px(remove.style.top) + 22).closeTo(10, 1e-9)

    // The label clears the circle, and starts where the kind pill's does.
    expect(px(pill.style.paddingRight)).greaterThan(10 + 6)
    expect(px(pill.style.paddingLeft)).equals(10)

    await act(async () => {
      pill.click()
    })
    expect(removed, 'a tap on the pill itself').equals(0)
    await act(async () => {
      remove.click()
    })
    expect(removed).equals(1)
  })

  it('reaches a suggested pill’s target up and down to 44 points', function () {
    expect(suggestedSlop(20)).deep.equals({ top: 12, bottom: 12 })
    expect(20 + 12 + 12).equals(44)
    expect(suggestedSlop(60)).deep.equals({ top: 0, bottom: 0 })
  })

  it('chooses a suggested place with a tap anywhere on it, at the kind pill’s size, and draws no X', async function () {
    let chosen = 0
    await mount(
      <LocationPill
        label="California"
        onPress={() => {
          chosen++
        }}
      />
    )
    const pill = byTestId('location-pill')!
    expect(pill.getAttribute('aria-label')).equals('Choose California')
    expect(pill.style.height).equals('20px')
    expect(px(pill.style.paddingLeft)).equals(10)
    expect(px(pill.style.paddingRight)).equals(10)
    expect(hex(window.getComputedStyle(pill).backgroundColor)).equals(
      tsBallpark.neutralBadgeBackground
    )
    expect(byTestId('location-pill-mark')).equals(null)
    await act(async () => {
      pill.click()
    })
    expect(chosen).equals(1)
  })
})
