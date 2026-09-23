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
      expect(targets.safe.y).at.least(66)
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
