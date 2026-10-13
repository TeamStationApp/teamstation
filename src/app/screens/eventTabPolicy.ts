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

export function defaultEventTab(
  event: EventTabState,
  now = Date.now()
): 'info' | 'boxScore' {
  return event.eventKind !== 'event' &&
    (event.hasScoringEvents === true || eventEnded(event, now))
    ? 'boxScore'
    : 'info'
}
