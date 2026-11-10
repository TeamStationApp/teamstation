import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GestureResponderEvent } from 'react-native'

import type { PlanCell } from '../../../common/gamePlan'
import { ThemeProvider } from '../../theme/ThemeContext'
import { DEFENSE_LOCATIONS } from '../DefensiveField'
import {
  CHIP_HEIGHT,
  CHIP_SLIDE,
  CHIP_WIDTH,
  FIELD_ART,
  PICKER_FIELD_HEIGHT,
  PICKER_LOCATIONS,
  pickerFieldWidth,
  pickerLocations,
  PlanFieldPicker
} from './PlanFieldPicker'
import { ENLARGED_LIFT, ENLARGED_SCALE, type PlanPoint } from './planGesture'
import { PLAN_PICKER_WIDTH } from './planLayout'

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

interface Calls {
  picked: PlanCell[]
  held: Array<[PlanCell, PlanPoint]>
  ended: number
}
async function mount(
  over: PlanCell | null = null,
  width?: number
): Promise<Calls> {
  const calls: Calls = { picked: [], held: [], ended: 0 }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <PlanFieldPicker
          title="Assign: Babe Ruth #3 (Inn 2)"
          value="C"
          over={over}
          {...(width == null ? {} : { width })}
          onPick={value => calls.picked.push(value)}
          onClose={() => undefined}
          onHold={(target, point) => calls.held.push([target, point])}
          onHoldEnd={() => {
            calls.ended++
          }}
        />
      </ThemeProvider>
    )
  })
  return calls
}
const byId = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
/** A style's length in points. */
const px = (node: Element, name: 'left' | 'top' | 'width' | 'height'): number =>
  parseFloat(getComputedStyle(node)[name])
/** Where a position's chip sits on the field, in points. */
const chipAt = (position: string): { x: number; y: number } => {
  const wrapper = byId(`Plan pick ${position}`).parentElement!
  return { x: px(wrapper, 'left'), y: px(wrapper, 'top') }
}
/** A field place in points, on the full-width card's field. */
const points = ([x, y]: readonly [number, number]): [number, number] => [
  (pickerFieldWidth(PLAN_PICKER_WIDTH) * x) / 100,
  (PICKER_FIELD_HEIGHT * y) / 100
]

describe('the game plan picker', function () {
  it('is 15% narrower than its old 320 points, its field in the art’s own 3:2', async function () {
    expect(PLAN_PICKER_WIDTH).equals(0.85 * 320)
    await mount()
    expect(px(byId('Plan field picker'), 'width')).equals(0.85 * 320)
    expect(pickerFieldWidth(PLAN_PICKER_WIDTH) / PICKER_FIELD_HEIGHT).equals(
      360 / 240
    )
  })

  it('puts P on the mound, and C, the outfield and nothing else where the Defense tab does', async function () {
    expect(PICKER_LOCATIONS.P).deep.equals(FIELD_ART.mound)
    for (const position of ['C', 'LF', 'CF', 'RF'] as const)
      expect(PICKER_LOCATIONS[position]).deep.equals(
        DEFENSE_LOCATIONS[position]
      )
    await mount()
    const [x, y] = points(FIELD_ART.mound)
    expect(chipAt('P')).deep.equals({
      x: x - CHIP_WIDTH / 2,
      y: y - CHIP_HEIGHT / 2
    })
  })

  it('slides 1B and 2B up and left along the path from first to second, and 3B and SS up and right from third, by half a chip’s diagonal', async function () {
    expect(CHIP_SLIDE).closeTo(Math.hypot(44, 26) / 2, 1e-9)
    expect(CHIP_SLIDE).closeTo(25.6, 0.1)
    for (const [positions, from] of [
      [['1B', '2B'], FIELD_ART.first],
      [['3B', 'SS'], FIELD_ART.third]
    ] as const) {
      const [pathX, pathY] = points(FIELD_ART.second).map(
        (end, axis) => end - points(from)[axis]
      )
      for (const position of positions) {
        const [oldX, oldY] = points(DEFENSE_LOCATIONS[position])
        const [newX, newY] = points(PICKER_LOCATIONS[position])
        const [dx, dy] = [newX - oldX, newY - oldY]
        expect(Math.hypot(dx, dy), position).closeTo(CHIP_SLIDE, 1e-9)
        // Along the path, toward second base: up, and in from its side.
        expect(dx * pathY - dy * pathX, position).closeTo(0, 1e-9)
        expect(dx * pathX + dy * pathY, position).greaterThan(0)
        expect(dy, position).lessThan(0)
        expect(Math.sign(dx), position).equals(
          from === FIELD_ART.first ? -1 : 1
        )
      }
    }
    // A narrower card's field slides them as far, in its own percent.
    const narrow = pickerLocations(200, PICKER_FIELD_HEIGHT)
    const [x1, y1] = DEFENSE_LOCATIONS['1B']
    const [x2, y2] = narrow['1B']
    expect(
      Math.hypot(
        ((x2 - x1) * 200) / 100,
        ((y2 - y1) * PICKER_FIELD_HEIGHT) / 100
      )
    ).closeTo(CHIP_SLIDE, 1e-9)
    // Drawn where the table puts them.
    await mount()
    for (const position of ['1B', '2B', '3B', 'SS']) {
      const [x, y] = points(
        PICKER_LOCATIONS[position as keyof typeof PICKER_LOCATIONS]
      )
      const at = chipAt(position)
      expect(at.x, position).closeTo(x - CHIP_WIDTH / 2, 0.01)
      expect(at.y, position).closeTo(y - CHIP_HEIGHT / 2, 0.01)
    }
  })

  it('draws the held or hovered target’s box half as large again, its bottom three quarters of a box above it, taking no touches', async function () {
    await mount('SS')
    const enlarged = byId('Plan pick enlarged')
    expect(enlarged.textContent).equals('SS')
    expect(getComputedStyle(enlarged).pointerEvents).equals('none')
    const width = px(enlarged, 'width')
    const height = px(enlarged, 'height')
    expect(width).equals(ENLARGED_SCALE * CHIP_WIDTH)
    expect(height).equals(ENLARGED_SCALE * CHIP_HEIGHT)
    // The chip in the card's coordinates, inside its border: past its
    // padding, and its title row and gap.
    const chip = chipAt('SS')
    const chipLeft = 10 + chip.x
    const chipTop = 10 + 28 + 8 + chip.y
    expect(px(enlarged, 'left') + width / 2).closeTo(
      chipLeft + CHIP_WIDTH / 2,
      0.01
    )
    expect(px(enlarged, 'top') + height).closeTo(
      chipTop - ENLARGED_LIFT * CHIP_HEIGHT,
      0.01
    )
    // Over the card's edge, it is kept inside the card.
    await act(async () => {
      root!.unmount()
    })
    host!.remove()
    await mount('CF')
    expect(px(byId('Plan pick enlarged'), 'top')).equals(0)
    await act(async () => {
      root!.unmount()
    })
    host!.remove()
    await mount('')
    const bench = byId('Plan pick enlarged')
    expect(bench.textContent).equals('Bench')
    expect(px(bench, 'left') + px(bench, 'width')).at.most(
      PLAN_PICKER_WIDTH - 2
    )
  })

  it('writes a tapped target, and reports a hold and its release, with no enlarged box until then', async function () {
    const calls = await mount()
    expect(document.querySelector('[data-testid="Plan pick enlarged"]')).equals(
      null
    )
    await act(async () => {
      byId('Plan pick LF').click()
    })
    expect(calls.picked).deep.equals(['LF'])
    const props = (id: string): Record<string, unknown> => {
      const node = byId(id)
      const key = Object.keys(node).find(each =>
        each.startsWith('__reactFiber$')
      )!
      let fiber = Reflect.get(node, key) as {
        memoizedProps: Record<string, unknown>
        return: unknown
      } | null
      while (fiber != null && fiber.memoizedProps.onLongPress == null)
        fiber = fiber.return as typeof fiber
      return fiber!.memoizedProps
    }
    const bench = props('Plan pick bench')
    expect(bench.delayLongPress).equals(300)
    await act(async () => {
      ;(bench.onLongPress as (event: GestureResponderEvent) => void)(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        { nativeEvent: { pageX: 12, pageY: 34 } } as GestureResponderEvent
      )
      ;(bench.onPressOut as () => void)()
    })
    expect(calls.held).deep.equals([['', { x: 12, y: 34 }]])
    expect(calls.ended).equals(1)
  })
})
