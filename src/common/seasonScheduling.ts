import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from './asLiteral'
import { viewerTimezone } from './eventTime'
import { addDays, type WindowPeriod } from './fieldAvailability'
import { asCalendarDate, isRecord } from './groupCreation'
import {
  asBlackouts,
  asFieldSize,
  asWeeklyHours,
  type FieldSize
} from './venues'

/** Whether a team may play twice in a day. */
export const DOUBLEHEADERS = ['never', 'ifNecessary', 'allowed'] as const
export type Doubleheaders = (typeof DOUBLEHEADERS)[number]
export const asDoubleheaders = asLiteral(...DOUBLEHEADERS)

export function doubleheadersLabel(value: Doubleheaders): string {
  return value === 'never'
    ? 'Never'
    : value === 'ifNecessary'
      ? 'Only if necessary'
      : 'Allowed'
}

/** Games and the gaps between them start and run in 5-minute steps. */
export const MINUTE_STEP = 5
export const GAME_MINUTES = { min: 30, max: 600 } as const
export const BUFFER_MINUTES = { min: 0, max: 240 } as const
export const MAX_GAMES = 200
export const MAX_WINDOW_PERIODS = 20

/** What a season's schedule is built from. */
export interface ScheduleSettings {
  fieldSize: FieldSize
  gameMinutes: number
  /** The time kept free on a field between one game and the next. */
  bufferMinutes: number
  /** Regular-season games each participant plays. */
  regularGames: number
  /** Exhibition games each participant plays. */
  exhibitionGames: number
  doubleheaders: Doubleheaders
  startsOn: string
  endsOn: string
  blackouts: string[]
  /**
   * The weekly game windows, each period in force from its `from` date
   * through its `until`, or until the next period or the season's end.
   */
  windows: WindowPeriod[]
}

function asSteppedMinutes(
  what: string,
  range: { min: number; max: number }
): Cleaner<number> {
  return raw => {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < range.min ||
      raw > range.max ||
      raw % MINUTE_STEP !== 0
    )
      throw new TypeError(
        `Choose ${what} from ${range.min} to ${range.max} minutes, in ${MINUTE_STEP}-minute steps`
      )
    return raw
  }
}

function asGameCount(what: string): Cleaner<number> {
  return raw => {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < 0 ||
      raw > MAX_GAMES
    )
      throw new TypeError(`Choose ${what} from 0 to ${MAX_GAMES}`)
    return raw
  }
}

/**
 * A season's window periods: dated, one per date, oldest first, each ending,
 * if it has an end date, on or after its start and before the next begins.
 */
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

/**
 * The periods with one more starting on `date`, a copy of the weekly hours
 * of the period before it. A date inside a dated period splits it: that
 * period ends the day before, and the new one ends where it did. Otherwise
 * the new period has no end date. A date no period comes before starts
 * with no hours.
 */
export function addWindowPeriod(
  windows: readonly WindowPeriod[],
  date: string
): WindowPeriod[] {
  const before = [...windows].reverse().find(period => period.from < date)
  const hours = (before?.hours ?? []).map(day => ({ ...day }))
  const until = before?.until
  const splits = until != null && until >= date
  const added: WindowPeriod = splits
    ? { from: date, until, hours }
    : { from: date, hours }
  return [
    ...windows.map(period =>
      splits && period === before
        ? { ...period, until: addDays(date, -1) }
        : period
    ),
    added
  ].sort((a, b) => a.from.localeCompare(b.from))
}

/** The days from one calendar date to another; negative when it is earlier. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) /
      86_400_000
  )
}

/**
 * Another season's window periods, moved to this season: every date shifts
 * by the days between the two seasons' starts, so each period keeps its
 * place in the season, its length and its gaps. Periods that would start
 * after this season ends are dropped, and an end past it ends with it. The
 * weekly hours are kept as they are. Empty when no period is left.
 */
export function copyWindowPeriods(
  source: Pick<ScheduleSettings, 'startsOn' | 'windows'>,
  target: Pick<ScheduleSettings, 'startsOn' | 'endsOn'>
): WindowPeriod[] {
  const shift = daysBetween(source.startsOn, target.startsOn)
  return source.windows.flatMap((period): WindowPeriod[] => {
    const from = addDays(period.from, shift)
    if (from > target.endsOn) return []
    const hours = period.hours.map(day => ({ ...day }))
    if (period.until == null) return [{ from, hours }]
    const until = addDays(period.until, shift)
    return [
      { from, until: until > target.endsOn ? target.endsOn : until, hours }
    ]
  })
}

/** A whole set of settings, as a season admin saves it. */
export function asScheduleSettings(raw: unknown): ScheduleSettings {
  if (!isRecord(raw)) throw new TypeError('Choose the schedule settings')
  const startsOn = asCalendarDate(raw.startsOn)
  const endsOn = asCalendarDate(raw.endsOn)
  if (endsOn < startsOn)
    throw new TypeError('The last day must be on or after the first')
  return {
    fieldSize: asFieldSizeOf(raw.fieldSize),
    gameMinutes: asSteppedMinutes(
      'a game length',
      GAME_MINUTES
    )(raw.gameMinutes),
    bufferMinutes: asSteppedMinutes(
      'the time between games',
      BUFFER_MINUTES
    )(raw.bufferMinutes),
    regularGames: asGameCount('the regular-season games')(raw.regularGames),
    exhibitionGames: asGameCount('the exhibition games')(raw.exhibitionGames),
    doubleheaders: asDoubleheadersOf(raw.doubleheaders),
    startsOn,
    endsOn,
    blackouts: asBlackouts(raw.blackouts ?? []),
    windows: asWindowPeriods(raw.windows ?? [])
  }
}

function asFieldSizeOf(raw: unknown): FieldSize {
  try {
    return asFieldSize(raw)
  } catch {
    throw new TypeError('Choose a field size')
  }
}

function asDoubleheadersOf(raw: unknown): Doubleheaders {
  try {
    return asDoubleheaders(raw)
  } catch {
    throw new TypeError('Choose whether teams may play doubleheaders')
  }
}

/**
 * The settings of a season nobody has set up yet: its own dates, or its
 * year's when it has none, 120-minute games with 15 minutes between, no
 * games, doubleheaders only if necessary, and no windows.
 */
export function defaultScheduleSettings(season: {
  startsOn: string | null
  endsOn: string | null
  year: number
}): ScheduleSettings {
  return {
    fieldSize: '60/90',
    gameMinutes: 120,
    bufferMinutes: 15,
    regularGames: 0,
    exhibitionGames: 0,
    doubleheaders: 'ifNecessary',
    startsOn: season.startsOn ?? `${season.year}-01-01`,
    endsOn: season.endsOn ?? `${season.year}-12-31`,
    blackouts: [],
    windows: []
  }
}

const asWirePeriodFields = asObject({
  from: asString,
  until: asOptional(asString),
  hours: asArray(
    asObject({ weekday: asNumber, start: asString, end: asString })
  )
})

/** A period as the server sends it, with its end date only when it has one. */
function asWirePeriod(raw: unknown): WindowPeriod {
  const { until, ...period } = asWirePeriodFields(raw)
  return until == null ? period : { ...period, until }
}

const asWireSettings = asObject({
  fieldSize: asFieldSize,
  gameMinutes: asNumber,
  bufferMinutes: asNumber,
  regularGames: asNumber,
  exhibitionGames: asNumber,
  doubleheaders: asDoubleheaders,
  startsOn: asString,
  endsOn: asString,
  blackouts: asArray(asString),
  windows: asArray(asWirePeriod)
})

/** A season's settings as the server sends them. */
export const asSeasonScheduleSettings = asObject({
  seasonId: asString,
  /** False while the season still reads as defaults. */
  saved: asBoolean,
  /** The season's zone, after any zone the save adopted. */
  timezone: asString,
  settings: asWireSettings
})
export type SeasonScheduleSettings = ReturnType<typeof asSeasonScheduleSettings>

/** The zone a season still holds when nobody has chosen one. */
export const DEFAULT_SEASON_TIMEZONE = 'UTC'

/**
 * The zone a season's setup is shown and saved in: its own, or, while it
 * still holds the UTC default, the viewer's, which its next settings save
 * or build stores on it.
 */
export function seasonZone(
  season: { timezone: string },
  viewer: string = viewerTimezone()
): string {
  return season.timezone === DEFAULT_SEASON_TIMEZONE ? viewer : season.timezone
}

/**
 * The zone a save or a build was set up in, when it names one. Whether the
 * zone exists is checked where it is stored.
 */
export function asTimezoneOption(raw: unknown): string | undefined {
  if (raw == null) return undefined
  if (typeof raw !== 'string' || raw === '' || raw.length > 64)
    throw new TypeError('Choose a timezone')
  return raw
}

/** One of the league's seasons, as the setup lists them. */
export const asSetupSeason = asObject({
  id: asString,
  name: asString,
  year: asNumber,
  timezone: asString,
  /** The teams the scheduler gives games: the unflagged participants. */
  participants: asNumber,
  exhibitionTeams: asNumber,
  /** The season's teams the scheduler schedules, by name. */
  teams: asArray(
    asObject({ id: asString, name: asString, exhibition: asBoolean })
  ),
  saved: asBoolean,
  settings: asWireSettings
})
export type SetupSeason = ReturnType<typeof asSetupSeason>

/** A field in the registry the run may use, and whose venue it is. */
export const asSetupField = asObject({
  id: asString,
  name: asString,
  venueId: asString,
  venueName: asString,
  sizes: asArray(asFieldSize),
  /** The field's own dates; both or neither. */
  startsOn: asNullableString,
  endsOn: asNullableString,
  deleted: asBoolean,
  /** True when this league is among the venue's owners. */
  ours: asBoolean,
  /** The leagues whose claims on the venue count, by name; empty if none. */
  ownerNames: asArray(asString)
})
export type SetupField = ReturnType<typeof asSetupField>

function asNullableString(raw: unknown): string | null {
  if (raw === null) return null
  return asString(raw)
}

/** A league's Auto-Scheduler setup: the seasons and fields of its next run. */
export const asScheduleSetup = asObject({
  leagueId: asString,
  seasonIds: asArray(asString),
  fieldIds: asArray(asString),
  /** Every season of the league, chosen or not. */
  seasons: asArray(asSetupSeason),
  /** The fields of the league's venues, and any other field chosen. */
  fields: asArray(asSetupField)
})
export type ScheduleSetup = ReturnType<typeof asScheduleSetup>

function asIdList(what: string, max: number): Cleaner<string[]> {
  return raw => {
    if (
      !Array.isArray(raw) ||
      raw.length > max ||
      raw.some(id => typeof id !== 'string' || id === '')
    )
      throw new TypeError(`Choose at most ${max} ${what}`)
    return [...new Set(raw as string[])]
  }
}

export const MAX_SETUP_SEASONS = 20
export const MAX_SETUP_FIELDS = 100

/** The seasons and fields a league admin chooses for the next run. */
export function asScheduleSetupChoice(raw: unknown): {
  seasonIds: string[]
  fieldIds: string[]
} {
  if (!isRecord(raw)) throw new TypeError('Choose seasons and fields')
  return {
    seasonIds: asIdList('seasons', MAX_SETUP_SEASONS)(raw.seasonIds),
    fieldIds: asIdList('fields', MAX_SETUP_FIELDS)(raw.fieldIds)
  }
}
