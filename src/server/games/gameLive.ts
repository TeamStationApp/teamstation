import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'

export interface GameLiveState {
  startAt?: string | null
  endAt?: string | null
  status: string
  eventKind?: 'game' | 'event'
  hasScoringEvents?: boolean
}

/** The server's sole decision for the game LIVE flag on every projection. */
export function gameIsLive(game: GameLiveState, now = Date.now()): boolean {
  if (
    game.eventKind === 'event' ||
    game.status === 'final' ||
    game.status === 'cancelled' ||
    game.hasScoringEvents !== true
  )
    return false
  const start = game.startAt == null ? NaN : Date.parse(game.startAt)
  const explicitEnd = game.endAt == null ? NaN : Date.parse(game.endAt)
  const end = Number.isFinite(explicitEnd)
    ? explicitEnd
    : start + DEFAULT_EVENT_DURATION_MS
  const margin = 60 * 60 * 1000
  return (
    Number.isFinite(start) &&
    end >= start &&
    now >= start - margin &&
    now <= end + margin
  )
}
