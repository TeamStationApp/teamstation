import type { GameDetail, TeamStationClient } from '../api'
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
  client: Pick<TeamStationClient, 'game' | 'gameEvents'>,
  gameId: string
): Promise<{ game: GameDetail; stored: StoredGame }> {
  const [game, stored] = await Promise.all([
    client.game(gameId),
    client.gameEvents(gameId)
  ])
  return { game, stored }
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
