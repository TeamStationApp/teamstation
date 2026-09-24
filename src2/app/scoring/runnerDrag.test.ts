import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BASES } from '../field/fieldModel'
import { runnerDragView, runnerTargetAt, runnerTargets } from './runnerDrag'
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
})
