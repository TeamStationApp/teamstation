import type { GameDetail } from '../../common/api'
import type { ReplayBoxScore } from '../../common/replay/replayBoxScore'
import { replayScore, replaySourceOf } from '../../common/replay/replaySource'
import { replayPlays, storedRecordOf } from '../../common/scoring/gumbo'
import type { StoredGame } from '../../common/scoring/session'
import { mediaAt, wallAt, type WallTimeline } from '../../common/wallTimeline'

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

export function timelineFor(startAt: string | null): WallTimeline {
  const start = Date.parse(startAt ?? '')
  return {
    anchors: Number.isFinite(start) ? [[0, start]] : [],
    source: 'start',
    confidence: 'approximate',
    live: false,
    startAt
  }
}
export function targetTime(
  timeline: WallTimeline,
  wall: number,
  duration: number
): { seconds: number; available: boolean } | null {
  const media = mediaAt(timeline.anchors, wall)
  if (media === null) return null
  const seconds = media / 1000
  return {
    seconds: Math.max(0, Math.min(duration, seconds)),
    available: seconds >= 0 && seconds < duration
  }
}
export function commonStart(timelines: WallTimeline[]): number | null {
  const starts = timelines
    .map(t => wallAt(t.anchors, 0))
    .filter((n): n is number => n !== null)
  return starts.length === timelines.length && starts.length > 0
    ? Math.max(...starts)
    : null
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
