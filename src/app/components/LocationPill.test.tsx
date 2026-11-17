import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { LocationPill, locationPillGeometry } from './LocationPill'

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

describe('the location pill', function () {
  it('puts the circle on the midline, half the height in from the right, at 0.9 of half the height', function () {
    const geometry = locationPillGeometry(32)
    expect(geometry.radius).equals(14.4)
    expect(geometry.centreInset).equals(16)
    expect(geometry.centreY).equals(16)
    // The X spans 45% of the diameter, in 2-point strokes.
    expect(geometry.markSpan).closeTo(12.96, 1e-9)
    expect(geometry.markStroke).equals(2)
    expect(geometry.target).equals(44)
  })

  it('never draws the X thinner than 1.5, and never a target under 44', function () {
    expect(locationPillGeometry(20, 1).markStroke).equals(1.5)
    expect(locationPillGeometry(20).target).equals(44)
    // A pill big enough for a wider circle takes the circle as its target.
    expect(locationPillGeometry(100).target).equals(90)
  })

  it('draws a beige pill with a green circle and a round-capped white X, and only the X removes it', async function () {
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
    expect(pill.style.height).equals('32px')
    expect(window.getComputedStyle(pill).backgroundColor).equals(
      'rgb(234, 223, 200)'
    )
    expect(tsBallpark.pillBeige).equals('#EADFC8')

    const svg = byTestId('location-pill-mark')!
    const circle = svg.querySelector('circle')!
    expect(Number(circle.getAttribute('r'))).closeTo(14.4, 1e-9)
    expect(circle.getAttribute('fill')).equals(tsBallpark.pillCloseColor)
    const marks = [...svg.querySelectorAll('line')]
    expect(marks).length(2)
    for (const mark of marks) {
      expect(mark.getAttribute('stroke')).equals(tsBallpark.pillCloseMarkColor)
      expect(mark.getAttribute('stroke-width')).equals('2')
      expect(mark.getAttribute('stroke-linecap')).equals('round')
      const span = Math.abs(
        Number(mark.getAttribute('x2')) - Number(mark.getAttribute('x1'))
      )
      expect(span).closeTo(12.96, 1e-9)
    }
    // The circle's box: its centre 16 in from the right and 16 down.
    const box = svg.parentElement!
    expect(px(box.style.right) + px(box.style.width) / 2).closeTo(16, 1e-9)
    expect(px(box.style.top) + px(box.style.height) / 2).closeTo(16, 1e-9)

    // The X's target: 44 square, centred on the circle.
    const remove = byTestId('location-pill-remove')!
    expect(remove.getAttribute('aria-label')).equals('Remove San Diego, CA')
    expect(remove.style.width).equals('44px')
    expect(remove.style.height).equals('44px')
    expect(px(remove.style.right) + 22).closeTo(16, 1e-9)
    expect(px(remove.style.top) + 22).closeTo(16, 1e-9)

    // The label clears the circle.
    expect(px(pill.style.paddingRight)).greaterThan(16 + 14.4)
    expect(px(pill.style.paddingLeft)).equals(16)

    await act(async () => {
      pill.click()
    })
    expect(removed, 'a tap on the pill itself').equals(0)
    await act(async () => {
      remove.click()
    })
    expect(removed).equals(1)
  })

  it('chooses a suggested place with a tap anywhere on it, and draws no X', async function () {
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
    expect(byTestId('location-pill-mark')).equals(null)
    await act(async () => {
      pill.click()
    })
    expect(chosen).equals(1)
  })
})
