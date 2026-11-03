import type { GameDetail, TeamStationClient } from '../api'
import type { GameStatistics } from '../gameStatistics'
import type { SessionContext, StoredGame } from '../scoring/session'
import type { GameState } from '../scoring/state'
import {
  type ReplayBoxScore,
  replayBoxScore,
  scoredFrom
} from './replayBoxScore'
import {
  replayContextOf,
  type ReplayTimeline,
  replayTimelineOf
} from './replayTimeline'

export type ReplayGame = Parameters<typeof replayContextOf>[0]

/** Replay and video playback read the same authorized documents. */
export async function readReplaySource(
  client: Pick<TeamStationClient, 'game' | 'gameStatistics'>,
  gameId: string
): Promise<{
  game: GameDetail
  stored: StoredGame
  statistics: GameStatistics
}> {
  const [game, statistics] = await Promise.all([
    client.game(gameId),
    client.gameStatistics(gameId)
  ])
  return { game, stored: statistics.source, statistics }
}

export function replaySourceOf(
  game: ReplayGame,
  stored: StoredGame
): { context: SessionContext; timeline: ReplayTimeline } | null {
  const context = replayContextOf(game, stored)
  return context === null
    ? null
    : { context, timeline: replayTimelineOf(stored, context) }
}

/** The selected session is authoritative, including after a rewind or rewrite. */
export function replayScore(
  state: GameState,
  timeline: ReplayTimeline
): ReplayBoxScore {
  return replayBoxScore(state, scoredFrom(timeline.start, timeline.derived))
}
