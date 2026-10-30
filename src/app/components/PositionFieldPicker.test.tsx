import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { View } from 'react-native'

import type { PlayerPosition } from '../../common/playerSettings'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  FIELD_HEIGHT,
  FIELD_SPOTS,
  PositionFieldPicker,
  TOGGLE
} from './PositionFieldPicker'

let root: Root | undefined
const toggle = (position: string): HTMLElement =>
  document.querySelector<HTMLElement>(
    `[aria-label="Player position ${position}"]`
  )!

async function show(
  width: number,
  positions: PlayerPosition[] = [],
  onToggle: (position: PlayerPosition) => void = () => undefined
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <View style={{ width }}>
          <PositionFieldPicker positions={positions} onToggle={onToggle} />
        </View>
      </ThemeProvider>
    )
  })
  // jsdom lays nothing out: report the width the field was given, through
  // the View's own onLayout.
  const field = document.querySelector('[data-testid="Position field"]')!
  const key = Object.keys(field).find(one => one.startsWith('__reactFiber'))!
  let fiber = (field as unknown as Record<string, any>)[key]
  while (fiber != null && fiber.memoizedProps?.onLayout == null)
    fiber = fiber.return
  await act(async () => {
    fiber.memoizedProps.onLayout({
      nativeEvent: { layout: { width, height: FIELD_HEIGHT } }
    })
  })
}

describe('PositionFieldPicker', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  for (const width of [156, 200, 300])
    it(`places every position at its spot in a field ${width} wide`, async () => {
      await show(width)
      for (const { position, x, top } of FIELD_SPOTS) {
        const style = toggle(position).style
        expect(style.left, position).equals(`${(width - TOGGLE) * x}px`)
        expect(style.top, position).equals(`${top}px`)
        expect(style.width).equals(`${TOGGLE}px`)
      }
    })

  it('puts DH alone, centred beneath the field, and offers no EH', async () => {
    await show(200)
    expect(toggle('DH').style.top).equals('334px')
    expect(toggle('DH').style.left).equals(`${(200 - TOGGLE) / 2}px`)
    expect(
      FIELD_SPOTS.filter(spot => spot.top >= 334).map(spot => spot.position)
    ).deep.equals(['DH'])
    expect(toggle('EH')).equals(null)
    expect(FIELD_SPOTS).has.length(10)
  })

  it('reports the position toggled, and marks the chosen ones selected', async () => {
    const toggled: string[] = []
    await show(200, ['SS', 'CF'], position => toggled.push(position))
    await act(async () => {
      toggle('C').click()
      toggle('SS').click()
    })
    expect(toggled).deep.equals(['C', 'SS'])
    expect(toggle('SS').getAttribute('aria-selected')).equals('true')
    expect(toggle('CF').getAttribute('aria-selected')).equals('true')
    expect(toggle('C').getAttribute('aria-selected')).equals('false')
  })
})
