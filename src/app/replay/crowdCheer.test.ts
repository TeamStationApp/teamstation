import { expect } from 'chai'
import { describe, it } from 'mocha'

import { GUMBO_EVENT_TYPES } from '../../common/gumboEventTypes'
import { replayTimelineOf } from '../../common/replay/replayTimeline'
import {
  finalGame,
  replayContext,
  stateAfterSteps
} from '../../test/replayGameFixture'
import {
  bedGains,
  CHEER_GAIN,
  cheerForStep,
  cheerOf,
  type CheerSize,
  CROWD_CROSSFADE_SECONDS,
  CROWD_IDLE_GAIN,
  nextStartsAt
} from './crowdCheer'

const SIZES: Record<CheerSize, string[]> = {
  small: ['strikeout', 'strike_out', 'single'],
  medium: [
    'double',
    'double_play',
    'grounded_into_double_play',
    'strikeout_double_play',
    'sac_fly_double_play',
    'sac_bunt_double_play',
    'cs_double_play',
    'runner_double_play'
  ],
  large: [
    'triple',
    'triple_play',
    'grounded_into_triple_play',
    'strikeout_triple_play'
  ],
  huge: ['home_run']
}

describe('crowd cheers', function () {
  for (const [size, types] of Object.entries(SIZES))
    for (const type of types)
      it(`raises a ${size} cheer for ${type}`, function () {
        expect(GUMBO_EVENT_TYPES).includes(type)
        expect(cheerOf(type)).equals(size)
      })

  it('cheers every double play, triple play and strikeout the plays may name', function () {
    const named = GUMBO_EVENT_TYPES.filter(type =>
      /double_play|triple_play|strike_?out/.test(type)
    )
    expect(named.length).greaterThan(10)
    for (const type of named) expect(cheerOf(type), type).not.equals(null)
  })

  for (const type of ['walk', 'field_out', undefined, 'toString'])
    it(`raises none for ${type ?? 'no event type'}`, function () {
      expect(cheerOf(type)).equals(null)
    })

  it('grows louder with the play', function () {
    const gains = (['small', 'medium', 'large', 'huge'] as const).map(
      size => CHEER_GAIN[size]
    )
    for (let i = 1; i < gains.length; i++)
      expect(gains[i]).greaterThan(gains[i - 1])
    expect(gains.at(-1)).equals(1)
  })

  it('keeps the idle crowd about 12 dB under the smallest cheer, its file being 10 dB quieter', function () {
    // 30% under the 0.6 it had.
    expect(CROWD_IDLE_GAIN).equals(0.42)
    // The bed's file is −30 LUFS and the cheers' −20 LUFS, before gain.
    const loudness = (lufs: number, gain: number): number =>
      lufs + 20 * Math.log10(gain)
    const under =
      loudness(-20, CHEER_GAIN.small) - loudness(-30, CROWD_IDLE_GAIN)
    expect(under).closeTo(12.35, 0.05)
  })

  it('cheers the step that completes a play, in either half, and not the pitches before it', async function () {
    const timeline = replayTimelineOf(await finalGame(), replayContext())
    const shown = timeline.steps.map((step, i) => ({
      step,
      session: stateAfterSteps(timeline, i + 1)
    }))
    const cheers = shown.map(({ step, session }) => {
      const play = session.liveData.plays.allPlays.at(step.atBatIndex)
      return {
        half: play?.about.halfInning,
        type: play?.result.eventType,
        complete: play?.about.isComplete === true,
        cheer: cheerForStep(session, step)
      }
    })
    for (const half of ['top', 'bottom'])
      for (const [type, size] of [
        ['strikeout', 'small'],
        ['single', 'small'],
        ['home_run', 'huge']
      ] as const) {
        const play = cheers.find(
          entry => entry.half === half && entry.type === type && entry.complete
        )
        // The fixture's home runs are the home side's.
        if (type === 'home_run' && half === 'top') continue
        expect(play?.cheer, `${half} ${type}`).equals(size)
      }
    expect(
      cheers.find(entry => entry.type === 'grounded_into_double_play')?.cheer
    ).equals('medium')
    // A pitch that leaves its play open, and a play that cheers nothing.
    const open = cheers.filter(entry => !entry.complete)
    expect(open.length).greaterThan(10)
    for (const entry of open) expect(entry.cheer).equals(null)
    expect(cheers.find(entry => entry.type === 'walk')?.cheer).equals(null)
    // The pitch before a strikeout's last: the same play, not yet complete.
    const strikeout = timeline.steps.findIndex(
      (_, i) => cheers[i].type === 'strikeout' && cheers[i].complete
    )
    expect(
      cheerForStep(
        stateAfterSteps(timeline, strikeout),
        timeline.steps[strikeout]
      )
    ).equals(null)
  })
})

describe('the idle crowd’s crossfade', function () {
  const LENGTH = 22

  it('overlaps two copies by two seconds', function () {
    expect(CROWD_CROSSFADE_SECONDS).equals(2)
    expect(nextStartsAt(LENGTH)).equals(20)
    expect(nextStartsAt(10)).equals(8)
  })

  it('rises over the first two seconds, holds, and falls over the last two', function () {
    expect(bedGains(0, LENGTH)).equals(0)
    expect(bedGains(1, LENGTH)).closeTo(Math.SQRT1_2, 1e-12)
    expect(bedGains(2, LENGTH)).equals(1)
    expect(bedGains(LENGTH / 2, LENGTH)).equals(1)
    expect(bedGains(LENGTH - 2, LENGTH)).equals(1)
    expect(bedGains(LENGTH - 1, LENGTH)).closeTo(Math.SQRT1_2, 1e-12)
    expect(bedGains(LENGTH, LENGTH)).equals(0)
    // Before its start and past its end, silent.
    expect(bedGains(-1, LENGTH)).equals(0)
    expect(bedGains(LENGTH + 1, LENGTH)).equals(0)
    // A quarter of the way in: sin(π/8), not the linear 0.25.
    expect(bedGains(0.5, LENGTH)).closeTo(Math.sin(Math.PI / 8), 1e-12)
    expect(bedGains(LENGTH - 0.5, LENGTH)).closeTo(Math.sin(Math.PI / 8), 1e-12)
  })

  it('rises from silence however long the file, before its length is known', function () {
    expect(bedGains(0, Infinity)).equals(0)
    expect(bedGains(1, Infinity)).closeTo(Math.SQRT1_2, 1e-12)
    expect(bedGains(1000, Infinity)).equals(1)
  })

  it('keeps the two copies at equal power through the overlap', function () {
    for (let t = 0; t <= 2; t += 0.05) {
      const outgoing = bedGains(nextStartsAt(LENGTH) + t, LENGTH)
      const incoming = bedGains(t, LENGTH)
      expect(outgoing ** 2 + incoming ** 2, `at ${t.toFixed(2)} s`).closeTo(
        1,
        1e-12
      )
      // They cross: one falls as the other rises.
      if (t > 0 && t < 2) expect(outgoing).lessThan(1).and.greaterThan(0)
    }
    // Halfway, each at −3 dB.
    expect(bedGains(nextStartsAt(LENGTH) + 1, LENGTH)).closeTo(
      bedGains(1, LENGTH),
      1e-12
    )
  })
})
