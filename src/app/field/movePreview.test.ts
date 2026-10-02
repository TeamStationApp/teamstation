import { expect } from 'chai'
import { describe, it } from 'mocha'

import { createStartingPlayers } from './batterModel'
import {
  cameraDragValue,
  fieldViewportHeight,
  MAX_VIEWPORT_HEIGHT
} from './cameraModel'
import { advancePlayer, BASES, createPlayers, nextBase } from './fieldModel'
import { beginMove, finishMove, previewMove } from './movePreview'

describe('runner planning and viewport controls', function () {
  it('snaps only beyond halfway, never advances on a short or cancelled drag', function () {
    for (const index of [9, 10, 11]) {
      const runner = createPlayers()[index]
      const start = { ...runner.position }
      const next = nextBase(runner)
      const draft = beginMove(runner, 1, start)
      const fraction = (t: number): { x: number; z: number } => ({
        x: start.x + t * (next.x - start.x),
        z: start.z + t * (next.z - start.z)
      })
      previewMove(draft, fraction(0.49))
      expect(draft.commit).equals(false)
      finishMove(runner, draft)
      expect(runner.target).deep.equals(start)
      const second = beginMove(runner, 2, start)
      previewMove(second, fraction(0.51))
      expect(second.goal).deep.equals(next)
      advancePlayer(runner, 1)
      expect(runner.position).deep.equals(start)
      finishMove(runner, second)
      expect(runner.target).deep.equals(next)
      for (let frame = 0; frame < 1200; frame++) advancePlayer(runner, 1 / 60)
      expect(runner.position).deep.equals(next)
      expect(nextBase(runner)).deep.equals(BASES[(index - 6) % 4])
    }
  })
  it('lets a batter cross between boxes without snapping toward first', function () {
    const batter = createStartingPlayers().find(
      player => player.batting === true
    )!
    const draft = beginMove(batter, 1, batter.position)
    previewMove(draft, { x: 4, z: 0 })
    finishMove(batter, draft)
    expect(batter.target).deep.equals({ x: 4, z: 0 })
  })
  it('uses a width-based 4:5 viewport with a fixed cap and drag zoom in both directions', function () {
    expect(fieldViewportHeight(360)).equals(450)
    expect(fieldViewportHeight(500)).equals(625)
    expect(fieldViewportHeight(1400)).equals(MAX_VIEWPORT_HEIGHT)
    expect(cameraDragValue('zoom', 1, -50)).greaterThan(1)
    expect(cameraDragValue('zoom', 1, 50)).lessThan(1)
    expect(cameraDragValue('zoom', 1, -10000)).equals(1.8)
  })
})
