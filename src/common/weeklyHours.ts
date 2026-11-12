import { isRecord } from './groupCreation'

export interface WeekdayHours {
  /** 0 is Sunday. */
  weekday: number
  /** "HH:MM", on a 5-minute step. */
  start: string
  /** "HH:MM", after `start`; "24:00" is midnight at the day's end. */
  end: string
}

/** Minutes after midnight of a wall time, "24:00" being 1440. */
export function wallMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}

/** The wall time `minutes` after midnight, on a 5-minute step. */
export function wallTimeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function asWallTime(allowMidnightEnd: boolean) {
  return (raw: unknown): string => {
    if (typeof raw !== 'string' || !/^\d{2}:\d{2}$/.test(raw))
      throw new TypeError('Choose a time')
    const minutes = wallMinutes(raw)
    const hour = Number(raw.slice(0, 2))
    const minute = Number(raw.slice(3))
    if (
      minute > 59 ||
      (allowMidnightEnd ? minutes > 1440 : hour > 23) ||
      minute % 5 !== 0
    )
      throw new TypeError('Choose a time on a 5-minute step')
    return raw
  }
}

/** A week of opening hours: at most one range per weekday, in weekday order. */
export function asWeeklyHours(raw: unknown): WeekdayHours[] {
  if (!Array.isArray(raw)) throw new TypeError('Choose the weekly hours')
  const seen = new Set<number>()
  const hours = raw.map((entry: unknown): WeekdayHours => {
    if (!isRecord(entry)) throw new TypeError('Choose the weekly hours')
    const weekday = entry.weekday
    if (
      typeof weekday !== 'number' ||
      !Number.isInteger(weekday) ||
      weekday < 0 ||
      weekday > 6
    )
      throw new TypeError('Choose a day of the week')
    if (seen.has(weekday))
      throw new TypeError('Give each day of the week one range of hours')
    seen.add(weekday)
    const start = asWallTime(false)(entry.start)
    const end = asWallTime(true)(entry.end)
    if (wallMinutes(end) <= wallMinutes(start))
      throw new TypeError('The closing time must be after the opening time')
    return { weekday, start, end }
  })
  return hours.sort((a, b) => a.weekday - b.weekday)
}
