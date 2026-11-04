import type { GameDetail } from '../api'
import { replayPlays, storedRecordOf } from '../scoring/gumbo'
import type { StoredGame } from '../scoring/session'
import type { ReplayBoxScore } from './replayBoxScore'
import { replayScore, replaySourceOf } from './replaySource'

export interface BoxStep {
  at: number
  box: ReplayBoxScore
}

/** Rebuild from stamped actions; never substitute the final-game stat totals. */
export function boxTimeline(
  game: Pick<
    GameDetail,
    'id' | 'awayTeamId' | 'homeTeamId' | 'awayTeamName' | 'homeTeamName'
  >,
  stored: StoredGame
): BoxStep[] {
  const source = replaySourceOf(game, stored)
  if (source === null) return []
  const { context, timeline } = source
  const steps: BoxStep[] =
    timeline.derived === 0
      ? [{ at: -Infinity, box: replayScore(timeline.start, timeline) }]
      : []
  const fallback = new Map<number, number>()
  for (const play of stored.plays) {
    const at = Date.parse(play.about.endTime ?? '')
    if (Number.isFinite(at)) fallback.set(play.about.atBatIndex, at)
  }
  replayPlays(
    {
      plays: stored.plays.map(playbackDocument),
      currentPlay: playbackDocument(stored.currentPlay)
    },
    context,
    (state, index, time) => {
      const stamped = Date.parse(time ?? '')
      const at = Number.isFinite(stamped) ? stamped : fallback.get(index)
      if (at !== undefined)
        steps.push({ at, box: replayScore(state, timeline) })
    }
  )
  return steps.sort((a, b) => a.at - b.at)
}

/** The documents are JSON data; copying just the record preserves the original timing array. */
function playbackDocument<T>(play: T): T {
  const times = storedRecordOf(play)?.playbackTimes
  if (times === undefined) return play
  const document = play as T & { teamStation: Record<string, unknown> }
  return {
    ...document,
    teamStation: { ...document.teamStation, actionTimes: times }
  }
}
