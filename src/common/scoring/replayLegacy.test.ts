import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, F, game, TEAMS } from '../../test/scoringGames'
import { asCurrentPlay, asGumboPlay } from '../gumboPlay'
import {
  cleanAction,
  type ScoringAction,
  SPOKEN_RUNNER_REASONS
} from './actions'
import { documentOf } from './document'
import { recordOf, replayPlays } from './gumbo'
import { setupOf } from './state'

/**
 * A game scored before the ground-out rules: its actions name the out
 * `Throw Out`, carry no `advance`, and swap two batting slots with a roster
 * action that has no `keepSlot`. The fixture holds the plays that engine
 * stored and what replaying them gave it (origin/develop at d1ad5d7ef).
 */
const fixture = JSON.parse(
  readFileSync('src/common/scoring/fixtures/legacyThrowOut.json', 'utf8')
) as {
  stored: { plays: unknown[]; currentPlay: unknown }
  snapshot: unknown
}

describe('a game stored before ground outs advanced runners', function () {
  it('replays to the same plays, runners, credits and batter, with Throw Out read as Ground Out', function () {
    const replayed = replayPlays(
      {
        plays: fixture.stored.plays.map(play => asGumboPlay(play)),
        currentPlay: asCurrentPlay(fixture.stored.currentPlay)
      },
      { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }
    )
    expect(replayed.problems).deep.equals([])
    const live = replayed.state.liveData
    const snapshot = {
      plays: [...live.plays.allPlays, live.plays.currentPlay!].map(play => ({
        result: play.result,
        count: play.count,
        batter: play.matchup.batter.id,
        runners: play.runners.map(runner => ({
          movement: runner.movement,
          runner: runner.details.runner.id,
          reason: runner.details.movementReason,
          rbi: runner.details.rbi,
          credits: runner.credits.map(
            credit => `${credit.credit} ${credit.player.id}`
          )
        })),
        outSubtype: play.source.teamstation.outSubtype ?? null
      })),
      linescore: live.linescore,
      battingOrder: {
        away: live.boxscore.teams.away.battingOrder,
        home: live.boxscore.teams.home.battingOrder
      }
    }
    const renamed = JSON.parse(
      JSON.stringify(fixture.snapshot).replaceAll('Throw Out', 'Ground Out')
    ) as unknown
    expect(snapshot).deep.equals(renamed)
  })

  it('cleans a stored Throw Out reason as Ground Out', function () {
    const cleaned = cleanAction({
      type: 'runnerMovement',
      runner: 2,
      to: '1B',
      out: true,
      reason: 'Throw Out',
      fielders: [F.SS, F['1B']]
    })
    expect('action' in cleaned && cleaned.action).includes({
      reason: 'Ground Out'
    })
  })
})

describe('a ground out as this build stores it', function () {
  it('writes the reason Throw Out that installed builds read, and reads it back as Ground Out', function () {
    const actions: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        out: true,
        reason: 'Ground Out',
        fielders: [F.SS, F['1B']]
      },
      { type: 'gameFlow', kind: 'closePlay' }
    ]
    const state = after(game(), ...actions)
    const play = state.liveData.plays.allPlays[0]
    const stored = documentOf(state, play, {
      setupBefore: setupOf(game()),
      actions
    })
    const record = JSON.parse(JSON.stringify(stored.teamStation)) as {
      actions: Array<{ type: string; reason?: string }>
    }
    const reasons = record.actions.flatMap(action =>
      action.reason == null ? [] : [action.reason]
    )
    expect(reasons).deep.equals(['Throw Out'])
    // The reasons the builds before the rename clean a stored action with.
    expect(SPOKEN_RUNNER_REASONS).includes('Throw Out')
    const read = recordOf(JSON.parse(JSON.stringify(stored)), TEAMS)!
    expect(read.actions[2]).includes({ reason: 'Ground Out' })
  })
})

describe('the name a stored ground out goes by', function () {
  for (const subtype of ['Throw Out', 'Ground Out', 'Out at First'])
    it(`names ${subtype} a Groundout`, function () {
      const state = after(
        game(),
        { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
        { type: 'result', eventType: 'field_out', outBy: 'throw' },
        {
          type: 'runnerMovement',
          runner: 1,
          to: '1B',
          out: true,
          fielders: [F.SS, F['1B']]
        },
        { type: 'gameFlow', kind: 'closePlay' }
      )
      const play = structuredClone(state.liveData.plays.allPlays[0])
      play.source.teamstation.outSubtype = subtype
      const stamp = { setupBefore: setupOf(game()), actions: [] }
      expect(documentOf(state, play, stamp).result.event).equals('Groundout')
      play.source.teamstation.contactKind = 'bunt'
      expect(documentOf(state, play, stamp).result.event).equals(
        'Bunt Groundout'
      )
    })
})
