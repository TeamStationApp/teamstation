import {
  addDays,
  fieldWindows,
  intersect,
  type Interval,
  mergeIntervals,
  seasonWindows,
  wallInstant,
  weekdayOf
} from '../fieldAvailability'
import { gameCalendarDay } from '../gameTime'
import { MINUTE_STEP } from '../seasonScheduling'
import type { FieldSize } from '../venues'
import { firstNonZero } from './score'
import type { EngineField, EngineInput, EngineSeason } from './types'

export const MINUTE = 60_000
export const DAY = 86_400_000
const STEP = MINUTE_STEP * MINUTE

/** The parts of a day the time-of-day balance compares. */
export const MORNING = 0
export const AFTERNOON = 1
export const EVENING = 2

/** Where a game falls on a season's calendar, in the season's zone. */
export interface GamePoint {
  date: string
  /** Days since 1970-01-01, for spacing. */
  day: number
  /** 0 is Sunday. */
  weekday: number
  /** MORNING, AFTERNOON or EVENING. */
  timeOfDay: number
}

/** A start a season's game could take on a field. */
export interface Slot extends GamePoint {
  /** Its position in the season's slots, earliest first. */
  index: number
  seasonId: string
  fieldId: string
  size: FieldSize
  start: number
  end: number
  /** The other run seasons that need a size this field also sets up as. */
  scarcity: number
  /**
   * Whether it starts a whole number of games (and buffers) after its open
   * time begins, so games on these starts pack the time with no gaps.
   */
  onGrid: boolean
}

/** Time a field is open to a season on one date. */
export interface SeasonWindow {
  fieldId: string
  date: string
  start: number
  end: number
}

/**
 * How a season's field time divides, counted in back-to-back games: by part
 * of the day and by weekday. A team's games are balanced against this mix.
 */
export interface Supply {
  games: number
  timeOfDay: number[]
  weekdays: number[]
}

/** Everything a season can be given: its slots, open time and mix. */
export interface SeasonSlots {
  slots: Slot[]
  windows: SeasonWindow[]
  supply: Supply
}

/** The day number of a calendar date. */
export function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY)
}

/** The first 5-minute step at or after an instant. */
export function alignUp(instant: number): number {
  return Math.ceil(instant / STEP) * STEP
}

/** Reads instants as calendar points in one season's zone. */
export class SeasonClock {
  private readonly cutoffs = new Map<string, [number, number]>()

  constructor(readonly timezone: string) {}

  /** The part of the day an instant on a date falls in. */
  timeOfDay(date: string, instant: number): number {
    let cutoffs = this.cutoffs.get(date)
    if (cutoffs == null) {
      cutoffs = [
        wallInstant(date, '12:00', this.timezone),
        wallInstant(date, '17:00', this.timezone)
      ]
      this.cutoffs.set(date, cutoffs)
    }
    return instant < cutoffs[0]
      ? MORNING
      : instant < cutoffs[1]
        ? AFTERNOON
        : EVENING
  }

  /** The calendar point of an instant. */
  pointOf(instant: number): GamePoint {
    const date = gameCalendarDay(new Date(instant).toISOString(), this.timezone)
    return this.pointOn(date, instant)
  }

  /** The calendar point of an instant already known to fall on `date`. */
  pointOn(date: string, instant: number): GamePoint {
    return {
      date,
      day: dayNumber(date),
      weekday: weekdayOf(date),
      timeOfDay: this.timeOfDay(date, instant)
    }
  }
}

/** A field's open time on a season's date, read across zones if they differ. */
function fieldOpenOn(
  field: EngineField,
  date: string,
  timezone: string
): Interval[] {
  if (field.availability.timezone === timezone)
    return fieldWindows(field.availability, date)
  return [-1, 0, 1].flatMap(offset =>
    fieldWindows(field.availability, addDays(date, offset))
  )
}

/** The first date a season may still get a game. */
export function firstOpenDate(season: EngineSeason, notBefore: number): string {
  const today = gameCalendarDay(
    new Date(notBefore).toISOString(),
    season.timezone
  )
  return today > season.settings.startsOn ? today : season.settings.startsOn
}

/**
 * Every start a season's game can take on the run's fields: each date of the
 * season that isn't a blackout, each field that sets up as its size, and
 * every 5-minute step where the whole game fits inside both the field's
 * open time and the season's window. Zones in use are offset from UTC by
 * whole multiples of five minutes, so a 5-minute step in UTC is one on the
 * wall clock as well.
 */
export function seasonSlots(
  input: EngineInput,
  season: EngineSeason,
  clock: SeasonClock
): SeasonSlots {
  const { settings, timezone } = season
  const gameMs = settings.gameMinutes * MINUTE
  const stride = gameMs + settings.bufferMinutes * MINUTE
  const blackouts = new Set(settings.blackouts)
  const fields = input.fields.filter(field =>
    field.sizes.includes(settings.fieldSize)
  )

  const dates: Array<{ date: string; open: Interval[] }> = []
  for (
    let date = firstOpenDate(season, input.notBefore);
    date <= settings.endsOn;
    date = addDays(date, 1)
  ) {
    if (blackouts.has(date)) continue
    const open = seasonWindows(settings.windows, timezone, date)
    if (open.length > 0) dates.push({ date, open })
  }

  const slots: Slot[] = []
  const windows: SeasonWindow[] = []
  const supply: Supply = {
    games: 0,
    timeOfDay: [0, 0, 0],
    weekdays: [0, 0, 0, 0, 0, 0, 0]
  }
  fields.forEach(field => {
    const scarcity = input.seasons.filter(
      other =>
        other.id !== season.id && field.sizes.includes(other.settings.fieldSize)
    ).length
    for (const { date, open } of dates) {
      const fieldOpen = fieldOpenOn(field, date, timezone)
      if (fieldOpen.length === 0) continue
      const weekday = weekdayOf(date)
      for (const interval of mergeIntervals(intersect(fieldOpen, open))) {
        const start = Math.max(interval.start, input.notBefore)
        if (start >= interval.end) continue
        windows.push({ fieldId: field.id, date, start, end: interval.end })
        for (
          let at = alignUp(start);
          at + gameMs <= interval.end;
          at += stride
        ) {
          supply.games++
          supply.timeOfDay[clock.timeOfDay(date, at)]++
          supply.weekdays[weekday]++
        }
        const first = alignUp(start)
        for (let at = first; at + gameMs <= interval.end; at += STEP)
          slots.push({
            ...clock.pointOn(date, at),
            index: 0,
            seasonId: season.id,
            fieldId: field.id,
            size: settings.fieldSize,
            start: at,
            end: at + gameMs,
            scarcity,
            onGrid: (at - first) % stride === 0
          })
      }
    }
  })

  const fieldOrder = new Map(fields.map((field, i) => [field.id, i]))
  slots.sort((a, b) =>
    firstNonZero(
      a.start - b.start,
      (fieldOrder.get(a.fieldId) ?? 0) - (fieldOrder.get(b.fieldId) ?? 0)
    )
  )
  slots.forEach((slot, i) => {
    slot.index = i
  })
  return { slots, windows, supply }
}
