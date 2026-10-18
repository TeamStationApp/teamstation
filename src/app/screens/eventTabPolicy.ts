import type { EventMetadata } from '../../common/eventInfo'
import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'

export interface EventTabState extends EventMetadata {
  startAt?: string | null
  status: string
}

export function eventEndTime(event: EventTabState): number | null {
  if (event.eventKind === 'event') return null
  const explicit = event.endAt == null ? NaN : Date.parse(event.endAt)
  if (Number.isFinite(explicit)) return explicit
  const start = event.startAt == null ? NaN : Date.parse(event.startAt)
  return Number.isFinite(start) ? start + DEFAULT_EVENT_DURATION_MS : null
}

export function eventEnded(event: EventTabState, now = Date.now()): boolean {
  if (event.eventKind === 'event') return false
  const end = eventEndTime(event)
  return event.status === 'final' || (end != null && now >= end)
}

export type GameSection = 'info' | 'boxScore' | 'watch'

export interface GameSectionInput extends EventTabState {
  /** A video whose status is `live` is streaming now. */
  videos?: ReadonlyArray<{ status: string }>
}

function startReached(event: EventTabState, now: number): boolean {
  const start = event.startAt == null ? NaN : Date.parse(event.startAt)
  return Number.isFinite(start) && now >= start
}

/**
 * Info, Box score and Videos, left to right. The first is the section a
 * reader lands on when they have not chosen one.
 *
 * A standing play — a stored play, or an at-bat still being pitched — puts
 * Box score first. A live video puts Videos first once there is a standing
 * play, and also once the start time has been reached, whether or not
 * anybody has pitched. Before the start time a live video with no standing
 * play leaves Videos where it was.
 */
export function gameSectionOrder(
  event: GameSectionInput,
  now = Date.now()
): GameSection[] {
  if (event.eventKind === 'event') return ['info']
  const scored = event.hasScoringEvents === true
  const live = event.videos?.some(video => video.status === 'live') === true
  if (live && (scored || startReached(event, now)))
    return ['watch', 'boxScore', 'info']
  if (scored || eventEnded(event, now)) return ['boxScore', 'watch', 'info']
  return ['info', 'boxScore', 'watch']
}

export function defaultEventTab(
  event: GameSectionInput,
  now = Date.now()
): GameSection {
  return gameSectionOrder(event, now)[0]
}
