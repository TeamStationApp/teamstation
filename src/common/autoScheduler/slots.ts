import {
  addDays,
  fieldWindows,
  intersect,
  mergeIntervals,
  seasonWindows,
  wallInstant,
  weekdayOf
} from '../fieldAvailability'
import { gameCalendarDay } from '../gameTime'
import { MINUTE_STEP } from '../seasonScheduling'
import type { FieldSize } from '../venues'
import { firstNonZero } from './score'
import type { EngineInput, EngineSeason } from './types'

export const MINUTE = 60_000
export const DAY = 86_400_000
const STEP = MINUTE_STEP * MINUTE

/** The parts of a day the time-of-day balance compares. */
export const MORNING = 0
export const AFTERNOON = 1
export const EVENING = 2

/** Where a game falls on the calendar, in its field's zone. */
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

/**
 * Reads instants as calendar points in a zone: the zone of the field a game
 * is on, since a season is only dates and each field keeps its own time.
 */
export class LocalClock {
  private readonly cutoffs = new Map<string, [number, number]>()

  /** The part of the day an instant on a date in a zone falls in. */
  timeOfDay(date: string, instant: number, timezone: string): number {
    const key = `${timezone} ${date}`
    let cutoffs = this.cutoffs.get(key)
    if (cutoffs == null) {
      cutoffs = [
        wallInstant(date, '12:00', timezone),
        wallInstant(date, '17:00', timezone)
      ]
      this.cutoffs.set(key, cutoffs)
    }
    return instant < cutoffs[0]
      ? MORNING
      : instant < cutoffs[1]
        ? AFTERNOON
        : EVENING
  }

  /** The calendar point of an instant in a zone. */
  pointOf(instant: number, timezone: string): GamePoint {
    const date = gameCalendarDay(new Date(instant).toISOString(), timezone)
    return this.pointOn(date, instant, timezone)
  }

  /** The calendar point of an instant already known to fall on `date`. */
  pointOn(date: string, instant: number, timezone: string): GamePoint {
    return {
      date,
      day: dayNumber(date),
      weekday: weekdayOf(date),
      timeOfDay: this.timeOfDay(date, instant, timezone)
    }
  }
}

/**
 * The first date a season may still get a game on a field in a zone: its
 * first day, or, once it is under way, that zone's today.
 */
export function firstOpenDate(
  season: EngineSeason,
  notBefore: number,
  timezone: string
): string {
  const today = gameCalendarDay(new Date(notBefore).toISOString(), timezone)
  return today > season.settings.startsOn ? today : season.settings.startsOn
}

/**
 * Every start a season's game can take on the run's fields: each field that
 * sets up as its size, each date of the season that isn't a blackout, and
 * every 5-minute step where the whole game fits inside both the field's
 * open time and the season's window. A season is only dates, so its days,
 * blackouts and windows are read in the zone of each field, as the field's
 * own hours are, and two fields in different zones each keep their own.
 * Zones in use are offset from UTC by whole multiples of five minutes, so a
 * 5-minute step in UTC is one on the wall clock as well.
 */
export function seasonSlots(
  input: EngineInput,
  season: EngineSeason,
  clock: LocalClock
): SeasonSlots {
  const { settings } = season
  const gameMs = settings.gameMinutes * MINUTE
  const stride = gameMs + settings.bufferMinutes * MINUTE
  const blackouts = new Set(settings.blackouts)
  const fields = input.fields.filter(field =>
    field.sizes.includes(settings.fieldSize)
  )

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
    const { timezone } = field.availability
    for (
      let date = firstOpenDate(season, input.notBefore, timezone);
      date <= settings.endsOn;
      date = addDays(date, 1)
    ) {
      if (blackouts.has(date)) continue
      const open = seasonWindows(settings.windows, timezone, date)
      if (open.length === 0) continue
      const fieldOpen = fieldWindows(field.availability, date)
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
          supply.timeOfDay[clock.timeOfDay(date, at, timezone)]++
          supply.weekdays[weekday]++
        }
        const first = alignUp(start)
        for (let at = first; at + gameMs <= interval.end; at += STEP)
          slots.push({
            ...clock.pointOn(date, at, timezone),
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
