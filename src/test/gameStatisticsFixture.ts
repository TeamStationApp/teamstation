import type { GameStatistics } from '../common/gameStatistics'
import { replayBoxScore } from '../common/replay/replayBoxScore'
import { type ReplayGame, replaySourceOf } from '../common/replay/replaySource'
import { replayPlays } from '../common/scoring/gumbo'
import { forPlayback } from '../common/scoring/playbackTimes'
import type { StoredGame } from '../common/scoring/session'

/** Native scoring wire fixture; server integration tests verify imported projections. */
export function nativeStatistics(
  game: ReplayGame,
  stored: StoredGame
): GameStatistics {
  const source = replaySourceOf(game, stored)
  const boxes: GameStatistics['boxes'] = []
  const indices = new Map<number, number>()
  if (source !== null)
    replayPlays(
      {
        plays: stored.plays.map(forPlayback),
        currentPlay: forPlayback(stored.currentPlay)
      },
      source.context,
      (state, atBatIndex, time) => {
        const actionIndex = indices.get(atBatIndex) ?? 0
        indices.set(atBatIndex, actionIndex + 1)
        boxes.push({
          at: Number.isFinite(Date.parse(time ?? '')) ? Date.parse(time!) : 0,
          position: { atBatIndex, actionIndex },
          box: replayBoxScore(state),
          message: null
        })
      }
    )
  return {
    version: 'fixture',
    source: stored,
    board: { version: 'fixture', steps: [] },
    line: {
      version: 'fixture',
      teams: { away: game.awayTeamName, home: game.homeTeamName },
      steps: []
    },
    initial: source === null ? null : replayBoxScore(source.timeline.start),
    boxes
  }
}
