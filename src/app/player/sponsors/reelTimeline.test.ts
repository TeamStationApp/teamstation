import { expect } from 'chai'
import { describe, it } from 'mocha'

import { defaultSponsorSettings } from '../../../common/nodeSettings'
import type { GameSponsorReel } from '../../../common/sponsors/types'
import {
  gameVolumeAt,
  logoPlacementFor,
  reelAspect,
  reelAt
} from './reelTimeline'

const reel = (
  startMs: number,
  durationMs = 12000,
  id = `srp_${startMs}`
): GameSponsorReel => ({
  id,
  reelId: 'srl_a',
  url: 'https://example.test/reel.mp4',
  width: 640,
  height: 360,
  startMs,
  durationMs
})

const close = (actual: number, expected: number): void => {
  expect(actual).closeTo(expected, 1e-9)
}

/** U22: the reel timeline on a game's wall clock. */
describe('U22 reelTimeline', function () {
  const start = 1_000_000
  const one = reel(start)
  const end = start + one.durationMs

  it('plays a reel over [start, end): none before, offset 0 at the start, the offset mid-reel, none at the end', function () {
    expect(reelAt([one], start - 1)).equals(null)
    expect(reelAt([one], start)).deep.equals({ reel: one, offsetMs: 0 })
    expect(reelAt([one], start + 4500)).deep.equals({
      reel: one,
      offsetMs: 4500
    })
    expect(reelAt([one], end)).equals(null)
    expect(reelAt([], start)).equals(null)
    expect(reelAt([one], null)).equals(null)
    expect(reelAt([one], Number.NaN)).equals(null)
  })

  it('plays out the reel that started first where two overlap', function () {
    const later = reel(start + 2000, 12000, 'srp_later')
    expect(reelAt([later, one], start + 3000)?.reel).equals(one)
    expect(reelAt([later, one], end + 10)?.reel).equals(later)
  })

  it('fades the game to 0.2 over the second before a reel, holds it, and back over the second after', function () {
    close(gameVolumeAt([one], start - 1001), 1)
    close(gameVolumeAt([one], start - 1000), 1)
    close(gameVolumeAt([one], start - 500), 0.6)
    close(gameVolumeAt([one], start), 0.2)
    close(gameVolumeAt([one], start + 6000), 0.2)
    close(gameVolumeAt([one], end - 1), 0.2)
    close(gameVolumeAt([one], end), 0.2)
    close(gameVolumeAt([one], end + 500), 0.6)
    close(gameVolumeAt([one], end + 1000), 1)
    close(gameVolumeAt([], start), 1)
    close(gameVolumeAt([one], null), 1)
  })

  it('stays at 0.2 between back-to-back reels', function () {
    const next = reel(end, 10000, 'srp_next')
    for (const at of [end - 1, end, end + 1, end + 500, end + 999])
      close(gameVolumeAt([one, next], at), 0.2)
    close(gameVolumeAt([one, next], end + 10000 + 500), 0.6)
  })

  it('picks the node’s logo placement for each kind of player, and a reel’s own shape', function () {
    const overlay = {
      logo: defaultSponsorSettings.logo,
      reel: defaultSponsorSettings.reel
    }
    for (const kind of ['single', 'grid', 'tv', 'portrait'] as const)
      expect(logoPlacementFor(overlay, kind)).equals(overlay.logo[kind])
    expect(reelAspect(one)).closeTo(16 / 9, 1e-9)
    expect(reelAspect({ ...one, width: 360, height: 640 })).closeTo(
      9 / 16,
      1e-9
    )
    expect(reelAspect({ ...one, width: 0 })).closeTo(16 / 9, 1e-9)
    expect(reelAspect(null)).closeTo(16 / 9, 1e-9)
  })
})
