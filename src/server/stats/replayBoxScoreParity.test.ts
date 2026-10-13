import { expect } from 'chai'
import { describe, it } from 'mocha'

import { replayBoxScore } from '../../common/replay/replayBoxScore'
import { replayTimelineOf } from '../../common/replay/replayTimeline'
import {
  AWAY_PLAYERS,
  finalGame,
  HOME_PLAYERS,
  REPLAY_TEAMS,
  replayContext
} from '../../test/replayGameFixture'
import { gameStatLines } from './gumboStats'

/**
 * The replay's box score at the final out and the stats builder's lines for
 * the same stored plays agree, player by player.
 */
describe('replay box score against the stats builder', function () {
  this.timeout(20000)

  it('gives every batter and pitcher the lines the builder gives', async function () {
    const stored = await finalGame()
    const timeline = replayTimelineOf(stored, replayContext())
    const box = replayBoxScore(timeline.end)
    const known = new Set(
      [...AWAY_PLAYERS, ...HOME_PLAYERS].map(player => player.gumboId)
    )
    const result = gameStatLines(
      stored.plays,
      { homeTeamId: REPLAY_TEAMS.home.id, awayTeamId: REPLAY_TEAMS.away.id },
      known
    )
    if (result.kind !== 'lines') throw new Error(result.detail)
    // The game and the builder both name a player by their scoring id.
    const built = new Map(result.lines.map(line => [line.gumboId, line]))
    let batters = 0
    let pitchers = 0
    for (const side of [box.away, box.home]) {
      for (const line of side.batting) {
        const other = built.get(line.id)
        if (other == null) {
          expect([
            line.ab,
            line.r,
            line.h,
            line.rbi,
            line.bb,
            line.k
          ]).deep.equals([0, 0, 0, 0, 0, 0])
          continue
        }
        batters++
        expect(
          [line.ab, line.r, line.h, line.rbi, line.bb, line.k],
          line.name
        ).deep.equals([
          other.ab,
          other.r,
          other.h,
          other.rbi,
          other.bb,
          other.k
        ])
      }
      for (const line of side.pitching) {
        const other = built.get(line.id)!
        pitchers++
        expect(
          [line.outs, line.h, line.r, line.er, line.bb, line.k],
          line.name
        ).deep.equals([
          other.pitch_outs,
          other.pitch_h,
          other.pitch_r,
          other.pitch_er,
          other.pitch_bb,
          other.pitch_k
        ])
      }
    }
    expect(batters).greaterThan(15)
    expect(pitchers).equals(3)
  })
})
