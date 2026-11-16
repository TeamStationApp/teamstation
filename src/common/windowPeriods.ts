import { asCalendarDate, isRecord } from './groupCreation'
import { asWeeklyHours, type WeekdayHours } from './weeklyHours'

export interface WindowPeriod {
  from: string
  until?: string
  hours: WeekdayHours[]
}
export const MAX_WINDOW_PERIODS = 20
export const LEGACY_WINDOW_START = '0001-01-01'
export function weeklyWindow(hours: WeekdayHours[]): WindowPeriod[] {
  return [{ from: LEGACY_WINDOW_START, hours: hours.map(day => ({ ...day })) }]
}

export function asWindowPeriods(raw: unknown): WindowPeriod[] {
  if (!Array.isArray(raw)) throw new TypeError('Choose the game windows')
  if (raw.length > MAX_WINDOW_PERIODS)
    throw new TypeError(
      `Choose at most ${MAX_WINDOW_PERIODS} periods of game windows`
    )
  const periods = raw.map((entry: unknown): WindowPeriod => {
    if (!isRecord(entry)) throw new TypeError('Choose the game windows')
    const from = asCalendarDate(entry.from)
    const hours = asWeeklyHours(entry.hours)
    if (entry.until == null) return { from, hours }
    const until = asCalendarDate(entry.until)
    if (until < from)
      throw new TypeError(
        'End each period of game windows on or after the day it starts'
      )
    return { from, until, hours }
  })
  periods.sort((a, b) => a.from.localeCompare(b.from))
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].from === periods[i - 1].from)
      throw new TypeError('Start each period of game windows on its own date')
    const until = periods[i - 1].until
    if (until != null && until >= periods[i].from)
      throw new TypeError('Periods of game windows can’t overlap')
  }
  return periods
}
