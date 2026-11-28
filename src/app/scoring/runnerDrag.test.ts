import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BASES } from '../field/fieldModel'
import {
  chainPush,
  runnerDragView,
  runnerTargetAt,
  runnerTargets
} from './runnerDrag'
describe('constrained runner drag geometry', function () {
  for (const from of [0, 1, 2, 3])
    it(`constrains base ${from} to one segment and switches only past halfway`, function () {
      const start = BASES[from]
      const end = BASES[(from + 1) % 4]
      const dx = end.x - start.x
      const dz = end.z - start.z
      for (const p of [-1, 0, 0.49, 0.5, 0.51, 1, 2]) {
        const view = runnerDragView(
          'runner',
          from,
          { x: start.x + dx * p + dz * 3, z: start.z + dz * p - dx * 3 },
          () => ({ x: 200, y: 300 }),
          390,
          700
        )
        expect(view.to).equals(p > 0.5 ? from + 1 : from)
        expect(view.progress).closeTo(Math.max(0, Math.min(1, p)), 1e-10)
        expect(view.point.x).closeTo(start.x + dx * view.progress, 1e-10)
        expect(view.point.z).closeTo(start.z + dz * view.progress, 1e-10)
      }
    })
  it('offers a one-base retreat when canRetreat is set', function () {
    const from = 3
    const start = BASES[from]
    const back = BASES[from - 1]
    const dx = back.x - start.x
    const dz = back.z - start.z
    const view = runnerDragView(
      'runner',
      from,
      { x: start.x + dx * 0.75, z: start.z + dz * 0.75 },
      () => ({ x: 200, y: 300 }),
      390,
      700,
      true
    )
    expect(view.to).equals(2)
    expect(view.hovered).equals('safe')
  })

  it('ignores forward drag when canAdvance is false', function () {
    const from = 3
    const start = BASES[from]
    const forward = BASES[(from + 1) % 4]
    const dx = forward.x - start.x
    const dz = forward.z - start.z
    const view = runnerDragView(
      'runner',
      from,
      { x: start.x + dx * 0.9, z: start.z + dz * 0.9 },
      () => ({ x: 200, y: 300 }),
      390,
      700,
      true,
      false
    )
    expect(view.to).equals(from)
    expect(view.progress).equals(0)
  })

  it('clamps both targets together and ignores empty space and disabled Safe', function () {
    for (const anchor of [
      { x: -100, y: -100 },
      { x: 9999, y: 9999 }
    ]) {
      const targets = runnerTargets(anchor, 390, 500)
      expect(targets.safe.x).at.least(8)
      expect(targets.out.x + targets.out.width).at.most(382)
      expect(targets.safe.y).at.least(8)
      expect(targets.out.y + targets.out.height).at.most(500)
      for (const key of ['safe', 'out'] as const)
        expect(
          runnerTargetAt(targets, {
            x: targets[key].x + 10,
            y: targets[key].y + 10
          })
        ).equals(key)
      expect(
        runnerTargetAt(
          { ...targets, safeDisabled: 'Occupied' },
          { x: targets.safe.x + 10, y: targets.safe.y + 10 }
        )
      ).equals(undefined)
      expect(runnerTargetAt(targets, { x: 0, y: 0 })).equals(undefined)
    }
  })
})

describe('base-specific Safe and Out placement', function () {
  for (const base of [0, 1, 2, 3, 4])
    it(`places base ${base} decisions beside the base and preserves release hit tests`, function () {
      const anchor = { x: 450, y: 350 }
      const pair = runnerTargets(anchor, 900, 900, base)
      if (base === 2) {
        expect(pair.safe.y).equals(pair.out.y)
        expect(pair.safe.x).lessThan(anchor.x)
        expect(pair.out.x).greaterThan(anchor.x)
        expect(pair.safe.y + pair.safe.height).lessThan(anchor.y)
      } else {
        expect(pair.safe.x).equals(pair.out.x)
        expect(pair.safe.y + pair.safe.height).lessThan(pair.out.y)
        if (base === 3) expect(pair.out.x + pair.out.width).lessThan(anchor.x)
        else expect(pair.safe.x).greaterThan(anchor.x)
      }
      for (const key of ['safe', 'out'] as const)
        expect(
          runnerTargetAt(pair, { x: pair[key].x + 40, y: pair[key].y + 22 })
        ).equals(key)
      const small = runnerTargets({ x: 900, y: 900 }, 320, 292, base)
      expect(small.out.y + small.out.height).at.most(292 - 128)
      expect(small.out.x + small.out.width).at.most(312)
    })
  it('pushes the runners in the way by the dragged runner’s progress (U2)', function () {
    const along = (base: number, share: number): { x: number; z: number } => ({
      x: BASES[base].x + (BASES[(base + 1) % 4].x - BASES[base].x) * share,
      z: BASES[base].z + (BASES[(base + 1) % 4].z - BASES[base].z) * share
    })
    const check = (
      pushed: ReturnType<typeof chainPush>,
      expected: Array<[number, number]>
    ): void => {
      expect(pushed.map(item => item.base)).deep.equals(
        expected.map(([base]) => base)
      )
      pushed.forEach((item, index) => {
        const point = along(expected[index][0], expected[index][1])
        expect(item.point.x).closeTo(point.x, 1e-10)
        expect(item.point.z).closeTo(point.z, 1e-10)
      })
    }
    // 1st and 2nd: the runner on 2nd goes as far toward 3rd.
    check(chainPush(1, 0.5, [true, true, false]), [[2, 0.5]])
    // 1st and 3rd: nobody is in the way.
    check(chainPush(1, 0.5, [true, false, true]), [])
    // Bases loaded: 2nd toward 3rd and 3rd toward home.
    check(chainPush(1, 0.3, [true, true, true]), [
      [2, 0.3],
      [3, 0.3]
    ])
    check(chainPush(1, 0, [true, true, true]), [
      [2, 0],
      [3, 0]
    ])
    check(chainPush(1, 1, [true, true, false]), [[2, 1]])
    check(chainPush(2, 2, [false, true, true]), [[3, 1]])
    check(chainPush(1, -1, [true, true, false]), [[2, 0]])
    check(chainPush(0, 0.5, [true, true, true]), [])
    check(chainPush(3, 0.5, [true, true, true]), [])
    // A pointer two bases on still reports one base.
    const view = runnerDragView(
      'runner',
      1,
      { ...BASES[3] },
      () => ({ x: 200, y: 300 }),
      390,
      700
    )
    expect(view.to).equals(2)
  })
})
