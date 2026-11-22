import { DEFAULT_EVENT_DURATION_MS } from './eventTime'
import type { UmpireAvailability } from './umpires'

export interface UmpireInterval {
  startAt: string
  endAt: string | null
}
export interface UmpireFilters {
  priorSeasons?: boolean
  /** The reader's own zone: rows and conflict lines are dated in it. */
  timezone?: string
  /**
   * The zone `days`, `from` and `to` are matched in, a saved filter's own;
   * `timezone` when absent, and each game's zone when both are.
   */
  filterTimezone?: string
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
/** A time of day, `HH:mm` on the 24-hour clock. */
export const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
export function umpireFilterError(filters: UmpireFilters): string | null {
  for (const zone of [filters.timezone, filters.filterTimezone]) {
    if (zone == null) continue
    try {
      Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions()
    } catch {
      return 'Choose a valid timezone.'
    }
  }
  for (const time of [filters.from, filters.to])
    if (time != null && !CLOCK_PATTERN.test(time)) return 'Choose a valid time.'
  if (filters.from != null && filters.to != null && filters.to <= filters.from)
    return 'End time must be after start time.'
  if (
    filters.days?.some(day => !Number.isInteger(day) || day < 0 || day > 6) ===
    true
  )
    return 'Choose a valid weekday.'
  return null
}
/** `date`'s time of day in `timezone`, `HH:mm` on the 24-hour clock. */
export function localClock(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date)
}
/** The most zones whose date formatter `localDate` keeps. */
export const DATE_FORMAT_LIMIT = 64
/** The most spellings of zones `localDate` remembers the canonical name of. */
export const ZONE_SPELLING_LIMIT = DATE_FORMAT_LIMIT * 4
/**
 * `localDate`'s formatters, keyed on each zone's canonical name so every
 * spelling of a zone shares one, least recently used first. A request names
 * its own zone, so the map is bounded rather than left to grow.
 */
const dateFormats = new Map<string, Intl.DateTimeFormat>()
/** Each spelling `localDate` was given, to its zone's canonical name. */
const zoneSpellings = new Map<string, string>()
let dateFormatsBuilt = 0
/** How many zones `localDate` holds a formatter for. For tests. */
export function dateFormatCount(): number {
  return dateFormats.size
}
/** How many formatters `localDate` has built. For tests. */
export function dateFormatBuilds(): number {
  return dateFormatsBuilt
}
/** Puts `key` last in `map`, dropping the least recently used past `limit`. */
function keep<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  limit: number
): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest != null) map.delete(oldest)
  }
}
/**
 * `date`'s calendar date in `timezone`, `YYYY-MM-DD`. A zone's formatter is
 * kept, since a schedule read asks for every game's day.
 */
export function localDate(date: Date | number, timezone: string): string {
  let zone = zoneSpellings.get(timezone)
  let format = zone == null ? undefined : dateFormats.get(zone)
  if (zone == null || format == null) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    ++dateFormatsBuilt
    zone = format.resolvedOptions().timeZone
    format = dateFormats.get(zone) ?? format
  }
  keep(zoneSpellings, timezone, zone, ZONE_SPELLING_LIMIT)
  keep(dateFormats, zone, format, DATE_FORMAT_LIMIT)
  return format.format(date)
}
/**
 * A filter as it is saved and compared: each level once, and each day once
 * in order, Monday first.
 */
export function normalAvailability(
  availability: UmpireAvailability
): UmpireAvailability {
  return {
    ...availability,
    levels: [...new Set(availability.levels)],
    days: [...new Set(availability.days)].sort((a, b) => a - b)
  }
}
/** Whether a filter narrows nothing: no levels, no days and no range. */
export function availabilityIsEmpty(availability: UmpireAvailability): boolean {
  return (
    availability.levels.length === 0 &&
    availability.days.length === 0 &&
    availability.from == null &&
    availability.to == null
  )
}
/** A time zone's short name now, such as "CST", or the zone itself. */
export function shortZoneName(timezone: string, at = new Date()): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short'
      })
        .formatToParts(at)
        .find(part => part.type === 'timeZoneName')?.value ?? timezone
    )
  } catch {
    return timezone
  }
}
/**
 * Whether a saved filter (or none) allows a level: no level is asked for,
 * none is saved, or it is one of the saved ones.
 */
export function levelAllows(
  availability: UmpireAvailability | null,
  level?: string
): boolean {
  return (
    availability == null ||
    level == null ||
    availability.levels.length === 0 ||
    availability.levels.includes(level)
  )
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
  if (!levelAllows(availability, level)) return false
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
