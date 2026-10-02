import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, close, F, game } from '../../test/scoringGames'
import { GUMBO_EVENT_TYPES } from '../gumboEventTypes'
import { asGumboPlay, type GumboPlay } from '../gumboPlay'
import { documentOf } from './document'
import { EVENT_CLASS, hitsAndErrors } from './hitsAndErrors'
import { errorCredits, lineScore } from './linescore'
import { setupOf } from './state'

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

describe('event classes', function () {
  it('classifies every stored event type', function () {
    const expected: Record<string, [boolean, string | undefined]> = {
      pickoff_1b: [false, undefined],
      pickoff_2b: [false, undefined],
      pickoff_3b: [false, undefined],
      pitcher_step_off: [false, undefined],
      pickoff_error_1b: [false, 'error'],
      pickoff_error_2b: [false, 'error'],
      pickoff_error_3b: [false, 'error'],
      batter_timeout: [false, undefined],
      mound_visit: [false, undefined],
      no_pitch: [false, undefined],
      single: [true, 'hit'],
      double: [true, 'hit'],
      triple: [true, 'hit'],
      home_run: [true, 'hit'],
      double_play: [true, undefined],
      field_error: [true, 'error'],
      error: [false, 'error'],
      field_out: [true, undefined],
      fielders_choice: [true, undefined],
      fielders_choice_out: [true, undefined],
      force_out: [true, undefined],
      grounded_into_double_play: [true, undefined],
      grounded_into_triple_play: [true, undefined],
      strikeout: [true, 'strikeout'],
      strike_out: [true, 'strikeout'],
      strikeout_double_play: [true, 'strikeout'],
      strikeout_triple_play: [true, 'strikeout'],
      triple_play: [false, undefined],
      sac_fly: [true, undefined],
      catcher_interf: [false, undefined],
      batter_interference: [true, undefined],
      fielder_interference: [false, undefined],
      runner_interference: [false, undefined],
      fan_interference: [true, undefined],
      batter_turn: [false, undefined],
      ejection: [false, undefined],
      cs_double_play: [false, undefined],
      defensive_indiff: [false, undefined],
      sac_fly_double_play: [true, undefined],
      sac_bunt: [true, undefined],
      sac_bunt_double_play: [true, undefined],
      walk: [true, 'walk'],
      intent_walk: [false, undefined],
      hit_by_pitch: [true, 'hitByPitch'],
      injury: [false, undefined],
      os_ruling_pending_prior: [false, undefined],
      os_ruling_pending_primary: [false, undefined],
      at_bat_start: [false, undefined],
      passed_ball: [false, undefined],
      other_advance: [false, undefined],
      runner_double_play: [false, undefined],
      runner_placed: [false, undefined],
      pitching_substitution: [false, undefined],
      offensive_substitution: [false, undefined],
      defensive_switch: [false, undefined],
      umpire_substitution: [false, undefined],
      pitcher_switch: [false, undefined],
      game_advisory: [false, undefined],
      stolen_base: [false, undefined],
      stolen_base_2b: [false, undefined],
      stolen_base_3b: [false, undefined],
      stolen_base_home: [false, undefined],
      caught_stealing: [false, undefined],
      caught_stealing_2b: [false, undefined],
      caught_stealing_3b: [false, undefined],
      caught_stealing_home: [false, undefined],
      defensive_substitution: [false, undefined],
      pickoff_caught_stealing_2b: [false, undefined],
      pickoff_caught_stealing_3b: [false, undefined],
      pickoff_caught_stealing_home: [false, undefined],
      balk: [false, undefined],
      forced_balk: [false, undefined],
      wild_pitch: [false, undefined],
      other_out: [true, undefined],
      final_score: [false, undefined],
      score_correction: [false, undefined],
      gs_manual_placement: [true, undefined],
      gs_batter_out: [true, undefined],
      gs_batting_order: [false, undefined]
    }
    expect(Object.keys(expected).sort()).deep.equals(
      [...GUMBO_EVENT_TYPES].sort()
    )
    for (const type of GUMBO_EVENT_TYPES) {
      const [countable, stat] = expected[type]
      expect(EVENT_CLASS[type], type).deep.equals(
        stat == null ? { countable } : { countable, stat }
      )
      const counted = hitsAndErrors([{ halfInning: 'top', eventType: type }])
      expect(counted.known, type).equals(countable)
    }
  })

  it('counts a strikeout double play as a strikeout and ignores unknown types', function () {
    const counted = hitsAndErrors([
      { halfInning: 'bottom', eventType: 'strikeout_double_play' },
      { halfInning: 'bottom', eventType: 'no_such_type' }
    ])
    expect(counted.strikeouts).deep.equals({ away: 0, home: 1 })
    expect(counted.known).equals(true)
  })

  it('reads legacy codes as the listed ones, and charges a runner error to the fielders', function () {
    expect(
      hitsAndErrors([{ halfInning: 'top', eventType: 'manual_placement' }])
        .known
    ).equals(true)
    expect(
      hitsAndErrors([{ halfInning: 'top', eventType: 'catcher_interference' }])
        .known
    ).equals(false)
    const counted = hitsAndErrors([
      { halfInning: 'bottom', eventType: 'error' },
      { halfInning: 'top', eventType: 'pickoff_error_1b' },
      { halfInning: 'top', eventType: 'strikeout_triple_play' }
    ])
    expect(counted.errors).deep.equals({ away: 1, home: 1 })
    expect(counted.strikeouts).deep.equals({ away: 1, home: 0 })
  })
})

describe('errors from the credits (U18)', function () {
  /** A top-half play whose runners carry the credits given, entry by entry. */
  const document = (
    eventType: string,
    ...entries: Array<Array<{ credit: string; position?: unknown }>>
  ): GumboPlay =>
    asGumboPlay({
      about: {
        atBatIndex: 0,
        inning: 1,
        halfInning: 'top',
        startTime: null,
        endTime: null
      },
      result: { eventType, awayScore: 0, homeScore: 0, rbi: 0 },
      runners: entries.map(credits => ({ credits }))
    })

  it('counts a throwing error on a single as one error for the fielding side', function () {
    // The batter singles and takes second when the right fielder throws the
    // ball away: a hit for the visitors and an error for the home side.
    const single = document(
      'single',
      [{ credit: 'f_fielded_ball' }],
      [{ credit: 'f_throwing_error' }]
    )
    expect(errorCredits(single)).equals(1)
    const line = lineScore([single], [], 0, 0)
    expect(line.home).includes({ e: 1, h: 0 })
    expect(line.away).includes({ e: 0, h: 1 })
  })

  it('counts each error once: from its credits, or from the type when none is credited', function () {
    const counted = hitsAndErrors([
      // Scored in TeamStation: the error is on the batter's credits.
      { halfInning: 'top', eventType: 'field_error', errorCredits: 1 },
      // Imported: a batter reached on an error nobody was charged with.
      { halfInning: 'top', eventType: 'field_error' },
      { halfInning: 'top', eventType: 'field_error', errorCredits: 0 },
      // Two fielders erred on the one play.
      { halfInning: 'bottom', eventType: 'field_error', errorCredits: 2 },
      // A runner's error between pitches, credited, and a pickoff throw away.
      { halfInning: 'bottom', eventType: 'error', errorCredits: 1 },
      { halfInning: 'bottom', eventType: 'pickoff_error_1b' },
      // Errors on runners' advances on a hit and on an out.
      { halfInning: 'bottom', eventType: 'double', errorCredits: 1 },
      { halfInning: 'bottom', eventType: 'field_out', errorCredits: 1 },
      { halfInning: 'bottom', eventType: 'single' }
    ])
    expect(counted.errors).deep.equals({ home: 3, away: 6 })
    expect(
      errorCredits(
        document(
          'field_out',
          [{ credit: 'f_putout' }, { credit: 'f_fielding_error' }],
          [],
          [{ credit: 'f_assist' }, { credit: 'f_throwing_error' }]
        )
      )
    ).equals(2)
    expect(
      errorCredits(asGumboPlay({ ...document('single'), runners: undefined }))
    ).equals(0)
  })

  it('counts the error the scorer charged on a ball in play once', function () {
    const state = after(
      game(),
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_error' },
      {
        type: 'fieldingPlay',
        fielders: [F.SS],
        error: F.SS,
        errorKind: 'throwing'
      },
      close
    )
    const play = documentOf(state, state.liveData.plays.allPlays[0], {
      setupBefore: setupOf(game()),
      actions: []
    })
    expect(errorCredits(play)).equals(1)
    expect(lineScore([play], [], 0, 0).home.e).equals(1)
    expect(state.liveData.linescore.teams.home.errors).equals(1)
  })
})
