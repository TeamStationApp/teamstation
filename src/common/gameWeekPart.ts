import type { GameWeekPart, ScheduleSettings } from './seasonScheduling'

/** Calendar day numbers count dates, independently of timezone offsets and DST. */
export function gameWeekPart(day: number): {
  key: string
  part: GameWeekPart
  first: number
  last: number
} {
  const weekday = (((day + 3) % 7) + 7) % 7 // Monday = 0.
  const monday = day - weekday
  const weekend = weekday >= 5
  const first = monday + (weekend ? 5 : 0)
  const part = weekend ? 'weekend' : 'weekdays'
  return {
    key: `${monday}:${part}`,
    part,
    first,
    last: monday + (weekend ? 6 : 4)
  }
}

export function weekPartMaximum(
  settings: Pick<ScheduleSettings, 'maxGamesOnWeekdays' | 'maxGamesOnWeekend'>,
  part: GameWeekPart
): number {
  return (
    (part === 'weekdays'
      ? settings.maxGamesOnWeekdays
      : settings.maxGamesOnWeekend) ?? 1
  )
}
