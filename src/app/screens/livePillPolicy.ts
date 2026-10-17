import { eventEnded, type EventTabState } from './eventTabPolicy'

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
