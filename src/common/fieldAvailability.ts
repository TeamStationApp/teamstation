import { addDays } from './calendarDates'
import { gameCalendarDay, gameTime } from './gameTime'
import { wallMinutes, wallTimeOf, type WeekdayHours } from './venues'

// Re-exported for the modules that import it from here.
export { addDays }

/** When a field is open: its dates, weekly hours and blackouts, in a zone. */
export interface Availability {
  /** Both or neither; neither is open every date. */
  startsOn: string | null
  endsOn: string | null
  hours: WeekdayHours[]
  blackouts: string[]
  timezone: string
}

/** An interval of instants, in epoch milliseconds, end exclusive. */
export interface Interval {
  start: number
  end: number
}

/**
 * A field's availability: its own hours when it has them, otherwise the
 * venue's. Blackouts add up, since a day the venue is closed closes every
 * field.
 */
export function effectiveAvailability(
  venue: {
    defaultHours: WeekdayHours[]
    defaultBlackouts: string[]
    timezone: string
  },
  field: {
    startsOn: string | null
    endsOn: string | null
    hours: WeekdayHours[] | null
    blackouts: string[]
  }
): Availability {
  return {
    startsOn: field.startsOn,
    endsOn: field.endsOn,
    hours: field.hours ?? venue.defaultHours,
    blackouts: [
      ...new Set([...venue.defaultBlackouts, ...field.blackouts])
    ].sort(),
    timezone: venue.timezone
  }
}

/** The weekday of a calendar date, 0 being Sunday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay()
}

/**
 * The instant of a wall time on a date in a zone. "24:00" is the next day's
 * midnight. A time that a daylight-saving change skips becomes the first
 * minute after the gap.
 */
export function wallInstant(
  date: string,
  time: string,
  timezone: string
): number {
  if (time === '24:00') return wallInstant(addDays(date, 1), '00:00', timezone)
  let minutes = wallMinutes(time)
  for (;;) {
    try {
      return Date.parse(gameTime(date, wallTimeOf(minutes), timezone))
    } catch (error) {
      // Only a skipped time is retried, and a gap is never over two hours.
      if (minutes >= wallMinutes(time) + 120) throw error
      minutes += 5
    }
  }
}

function hoursOn(
  hours: WeekdayHours[],
  date: string,
  timezone: string
): Interval[] {
  const weekday = weekdayOf(date)
  return hours
    .filter(entry => entry.weekday === weekday)
    .map(entry => ({
      start: wallInstant(date, entry.start, timezone),
      end: wallInstant(date, entry.end, timezone)
    }))
}

/** The field's open intervals on a date in its own zone. */
export function fieldWindows(
  availability: Availability,
  date: string
): Interval[] {
  if (
    availability.startsOn != null &&
    availability.endsOn != null &&
    (date < availability.startsOn || date > availability.endsOn)
  )
    return []
  if (availability.blackouts.includes(date)) return []
  return hoursOn(availability.hours, date, availability.timezone)
}

/**
 * One period of a season's game windows, in force from `from` through
 * `until`, or, with no `until`, until the next period or the season's end.
 */
export interface WindowPeriod {
  from: string
  /** The period's last day, inclusive. */
  until?: string
  hours: WeekdayHours[]
}

/**
 * The period in force on a date: the last that has begun, unless it ended
 * before the date, which leaves the date with no windows.
 */
export function periodOn(
  periods: WindowPeriod[],
  date: string
): WindowPeriod | null {
  let found: WindowPeriod | null = null
  for (const period of [...periods].sort((a, b) =>
    a.from.localeCompare(b.from)
  ))
    if (period.from <= date) found = period
  return found?.until == null || date <= found.until ? found : null
}

/** The season's game windows on a date in its zone. */
export function seasonWindows(
  periods: WindowPeriod[],
  timezone: string,
  date: string
): Interval[] {
  const period = periodOn(periods, date)
  return period == null ? [] : hoursOn(period.hours, date, timezone)
}

/**
 * Whether a game fits wholly inside the field's open time: its windows on
 * the game's date and the dates either side, touching ones joined, as the
 * Auto-Scheduler reads them when it places games.
 */
export function coversGame(
  availability: Availability,
  startAt: string,
  endAt: string
): boolean {
  const start = Date.parse(startAt)
  const end = Date.parse(endAt)
  const date = gameCalendarDay(startAt, availability.timezone)
  return mergeIntervals(
    [-1, 0, 1].flatMap(offset =>
      fieldWindows(availability, addDays(date, offset))
    )
  ).some(window => window.start <= start && end <= window.end)
}

/** Overlapping or touching intervals joined into one. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const interval of sorted) {
    const last = out[out.length - 1]
    if (last != null && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end)
    else out.push({ ...interval })
  }
  return out
}

/** The overlap of two lists of intervals. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const x of a)
    for (const y of b) {
      const start = Math.max(x.start, y.start)
      const end = Math.min(x.end, y.end)
      if (start < end) out.push({ start, end })
    }
  return out.sort((x, y) => x.start - y.start)
}
