import { eventEnded, eventEndTime, type EventTabState } from './eventTabPolicy'

const GAME_LIVE_MARGIN_MS = 60 * 60 * 1000

/** Inclusive window around the scheduled range, using the usual fallback end. */
export function gameLiveWindow(event: EventTabState): [number, number] | null {
  const start = event.startAt == null ? NaN : Date.parse(event.startAt)
  const end = eventEndTime(event)
  if (!Number.isFinite(start) || end == null || end < start) return null
  return [start - GAME_LIVE_MARGIN_MS, end + GAME_LIVE_MARGIN_MS]
}

/** Scoring setup and events that have all been undone do not mean live play. */
export function showGameLivePill(
  event: EventTabState,
  now = Date.now()
): boolean {
  if (
    event.status === 'final' ||
    event.status === 'cancelled' ||
    event.hasScoringEvents !== true
  )
    return false
  const window = gameLiveWindow(event)
  return window != null && now >= window[0] && now <= window[1]
}

export interface VideoLivePillInput {
  status: string
  /**
   * Bytes are arriving on a stream of this video. Absent means they are not:
   * an older game payload has no such field.
   */
  receiving?: boolean
}

function startReached(event: EventTabState, now: number): boolean {
  const start = event.startAt == null ? NaN : Date.parse(event.startAt)
  return Number.isFinite(start) && now >= start
}

/**
 * The red pill on a video.
 *
 * Bytes arriving keep it up, including after the scheduled end, because the
 * camera is still on. A camera that connected and then dropped keeps the pill
 * only while the game is still on, so a reconnect still reads as live. Once
 * the game is over, a silent stream does not.
 */
export function showVideoLivePill(
  video: VideoLivePillInput | undefined,
  event: EventTabState,
  now = Date.now()
): boolean {
  if (video?.status !== 'live') return false
  if (video.receiving === true) return true
  return startReached(event, now) && !eventEnded(event, now)
}
