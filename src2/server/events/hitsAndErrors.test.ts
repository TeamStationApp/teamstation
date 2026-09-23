import { expect } from 'chai'
import { describe, it } from 'mocha'

import { hitsAndErrors } from './hitsAndErrors'

describe('the line score', function () {
  const play = (
    halfInning: 'top' | 'bottom' | null,
    eventType: string
  ): { halfInning: 'top' | 'bottom' | null; eventType: string } => ({
    halfInning,
    eventType
  })

  it('gives a hit to the side batting', function () {
    const { hits } = hitsAndErrors([
      play('top', 'single'),
      play('top', 'home_run'),
      play('bottom', 'double')
    ])
    expect(hits).deep.equals({ away: 2, home: 1 })
  })

  it('charges walks, strikeouts and home runs to the side batting', function () {
    const counted = hitsAndErrors([
      play('top', 'walk'),
      play('top', 'strikeout'),
      play('top', 'home_run'),
      play('bottom', 'strikeout'),
      play('bottom', 'walk'),
      play('bottom', 'walk')
    ])
    expect(counted.walks).deep.equals({ away: 1, home: 2 })
    expect(counted.strikeouts, 'the batters who struck out').deep.equals({
      away: 1,
      home: 1
    })
    expect(counted.homeRuns).deep.equals({ away: 1, home: 0 })
    expect(counted.hits, 'a home run is a hit as well').deep.equals({
      away: 1,
      home: 0
    })
  })

  it('does not count a hit batter as a walk', function () {
    // Reaching base the same way is not the same event, and every box score
    // ever printed keeps them in different columns. Merging them here would
    // make the game card disagree with the box score two taps away.
    const counted = hitsAndErrors([play('top', 'hit_by_pitch')])
    expect(counted.walks).deep.equals({ away: 0, home: 0 })
  })

  it('charges an error to the side that made it, not the side batting', function () {
    // The one everybody writes backwards: a batter reaching on an error is the
    // *fielding* team's error, so it belongs to the other side of the sheet.
    const { errors } = hitsAndErrors([play('top', 'field_error')])
    expect(errors, 'away batting means home was fielding').deep.equals({
      away: 0,
      home: 1
    })
  })

  it('counts only the four kinds of hit', function () {
    const { hits } = hitsAndErrors([
      play('top', 'walk'),
      play('top', 'field_out'),
      play('top', 'strikeout'),
      play('top', 'sac_fly')
    ])
    expect(hits).deep.equals({ away: 0, home: 0 })
  })

  it('ignores a play belonging to neither half', function () {
    const counted = hitsAndErrors([play(null, 'single')])
    expect(counted.hits).deep.equals({ away: 0, home: 0 })
  })

  it('says whether the plays can answer at all', function () {
    // A game with only a correction on it has no hits *recorded*, which is not
    // the same as no hits — so `0H` beside thirteen runs would be a claim
    // about the game rather than about our records.
    expect(hitsAndErrors([play('top', 'score_correction')]).known).equals(false)
    expect(hitsAndErrors([]).known).equals(false)
    expect(hitsAndErrors([play('top', 'field_out')]).known).equals(true)
    expect(hitsAndErrors([play('top', 'single')]).known).equals(true)
  })
})
