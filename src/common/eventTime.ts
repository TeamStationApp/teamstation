import { gameCalendarDay } from './gameTime'

export const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000

export function viewerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
}

export function effectiveEventEnd(
  startAt: string,
  endAt?: string | null
): string {
  return (
    endAt ??
    new Date(Date.parse(startAt) + DEFAULT_EVENT_DURATION_MS).toISOString()
  )
}

export function eventWallTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(instant))
}

export function eventLocalFields(
  instant: string,
  timezone: string
): { date: string; time: string } {
  return {
    date: gameCalendarDay(instant, timezone),
    time: eventWallTime(instant, timezone)
  }
}

/** Rounding is for a deliberate picker selection, never a loaded timestamp. */
export function nearestFiveMinutes(time: string): string {
  const [hour, minute] = time.split(':').map(Number)
  const total = (Math.round((hour * 60 + minute) / 5) * 5) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function eventLocalRange(
  startAt: string,
  endAt?: string | null,
  timezone = viewerTimezone()
): string {
  const start = new Date(startAt)
  const end = new Date(effectiveEventEnd(startAt, endAt))
  const day = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
  const time = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit'
  })
  const sameDay =
    gameCalendarDay(startAt, timezone) ===
    gameCalendarDay(end.toISOString(), timezone)
  return `${day.format(start)}, ${time.format(start)} – ${sameDay ? '' : `${day.format(end)}, `}${time.format(end)}`
}

export function eventArrivalTime(
  startAt: string,
  delta?: number | null,
  timezone = viewerTimezone()
): string | null {
  if (delta == null) return null
  const instant = new Date(Date.parse(startAt) - delta * 60000)
  const sameDay =
    gameCalendarDay(startAt, timezone) ===
    gameCalendarDay(instant.toISOString(), timezone)
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    ...(sameDay
      ? {}
      : {
          weekday: 'long' as const,
          month: 'long' as const,
          day: 'numeric' as const
        }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(instant)
}

export function eventHeroTime(
  startAt: string,
  endAt?: string | null,
  delta?: number | null,
  timezone = viewerTimezone()
): string {
  const arrival = eventArrivalTime(startAt, delta, timezone)
  return `${eventLocalRange(startAt, endAt, timezone)}${arrival == null ? '' : ` · Arrival ${arrival}`}`
}

/** Two logical lines, preserving overnight end dates and viewer-local arrival. */
export function eventHeroLines(
  startAt: string,
  endAt?: string | null,
  delta?: number | null,
  timezone = viewerTimezone()
): [string, string] {
  const date = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date(startAt))
  const time = eventHeroTime(startAt, endAt, delta, timezone).slice(
    date.length + 2
  )
  return [date, time]
}
