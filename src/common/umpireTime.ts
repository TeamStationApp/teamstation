import { DEFAULT_EVENT_DURATION_MS } from './eventTime'
import type { UmpireAvailability } from './umpires'

export interface UmpireInterval {
  startAt: string
  endAt: string | null
}
export interface UmpireFilters {
  priorSeasons?: boolean
  timezone?: string
  levels?: string[]
  days?: number[]
  from?: string
  to?: string
}
export function umpireEnd(game: UmpireInterval): number {
  return game.endAt == null
    ? Date.parse(game.startAt) + DEFAULT_EVENT_DURATION_MS
    : Date.parse(game.endAt)
}
export function hardUmpireConflict(
  game: UmpireInterval,
  other: UmpireInterval
): boolean {
  return (
    Date.parse(game.startAt) < umpireEnd(other) &&
    Date.parse(other.startAt) < umpireEnd(game)
  )
}
export function softUmpireConflict(
  game: UmpireInterval,
  other: UmpireInterval
): boolean {
  const a = Date.parse(game.startAt)
  const b = Date.parse(other.startAt)
  const ae = umpireEnd(game)
  const be = umpireEnd(other)
  const minute = 60000
  return (
    hardUmpireConflict(game, other) ||
    Math.abs(a - b) <= 15 * minute ||
    Math.abs(ae - be) <= 45 * minute ||
    Math.abs(a - be) <= 15 * minute ||
    Math.abs(ae - b) <= 45 * minute
  )
}
export function umpireCloseness(
  game: UmpireInterval,
  other: UmpireInterval
): string {
  if (hardUmpireConflict(game, other)) return 'overlaps this game'
  if (umpireEnd(other) <= Date.parse(game.startAt))
    return `ends ${Math.round((Date.parse(game.startAt) - umpireEnd(other)) / 60000)} minutes before this game starts`
  return `starts ${Math.round((Date.parse(other.startAt) - umpireEnd(game)) / 60000)} minutes after this game ends`
}
export function umpireDate(startAt: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).formatToParts(new Date(startAt))
  const part = (key: string): string => parts.find(p => p.type === key)!.value
  return `${part('month')} ${part('day')}, ${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`
}
export function umpireFilterError(filters: UmpireFilters): string | null {
  if (filters.timezone != null) {
    try {
      Intl.DateTimeFormat('en-US', {
        timeZone: filters.timezone
      }).resolvedOptions()
    } catch {
      return 'Choose a valid timezone.'
    }
  }
  for (const time of [filters.from, filters.to])
    if (time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      return 'Choose a valid time.'
  if (filters.from != null && filters.to != null && filters.to <= filters.from)
    return 'End time must be after start time.'
  if (
    filters.days?.some(day => !Number.isInteger(day) || day < 0 || day > 6) ===
    true
  )
    return 'Choose a valid weekday.'
  return null
}
function localClock(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date)
}
function localDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}
/**
 * Whether a saved availability filter leaves a time (and a level) in, as the
 * schedule's own filter leaves a game in. `null`, no saved filter, allows
 * everything.
 *
 * - `{ start }`: the start, in the saved time zone, falls on a saved day and
 *   within `from`–`to`, both ends inclusive. With `durationMinutes` the end
 *   must also fall by `to` on the same local date.
 * - `{ day, time }`: `day` (0 is Monday) is a saved day, and `time` is
 *   within `from`–`to`.
 * - `level`: a saved level, or none are saved.
 */
export function availabilityAllows(
  availability: UmpireAvailability | null,
  at: { start: Date; durationMinutes?: number } | { day: number; time: string },
  level?: string
): boolean {
  if (availability == null) return true
  if (
    level != null &&
    availability.levels.length > 0 &&
    !availability.levels.includes(level)
  )
    return false
  const { from, to } = availability
  if ('day' in at) {
    if (availability.days.length > 0 && !availability.days.includes(at.day))
      return false
    return from == null || to == null || (at.time >= from && at.time <= to)
  }
  const filters = {
    days: availability.days,
    from: from ?? undefined,
    to: to ?? undefined
  }
  if (
    !umpireTimeMatches(at.start.toISOString(), availability.timezone, filters)
  )
    return false
  if (at.durationMinutes == null || from == null || to == null) return true
  const end = new Date(at.start.getTime() + at.durationMinutes * 60000)
  return (
    localDate(end, availability.timezone) ===
      localDate(at.start, availability.timezone) &&
    localClock(end, availability.timezone) <= to
  )
}
export function umpireTimeMatches(
  startAt: string,
  timezone: string,
  filters: UmpireFilters
): boolean {
  const date = new Date(startAt)
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  }).format(date)
  if (
    filters.days != null &&
    filters.days.length > 0 &&
    !filters.days.includes(
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday)
    )
  )
    return false
  if (filters.from == null || filters.to == null) return true
  const time = localClock(date, timezone)
  return time >= filters.from && time <= filters.to
}
export function umpireWindowsOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string }
): boolean {
  return a.start <= b.end && b.start <= a.end
}
