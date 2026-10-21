import { DEFAULT_EVENT_DURATION_MS } from './eventTime'

export interface UmpireInterval {
  startAt: string
  endAt: string | null
}
export interface UmpireFilters {
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
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date)
  return time >= filters.from && time <= filters.to
}
export function umpireWindowsOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string }
): boolean {
  return a.start <= b.end && b.start <= a.end
}
