import type { WeekdayHours } from '../venues'
import type { EngineField, EngineInput, EngineSeason, FixedGame } from './types'

// Inputs the engine suites share: invented teams on an invented field.

export const ZONE = 'America/Chicago'
export const SEASON = 'sea_demo'
export const FIELD = 'fld_one'

export const PARTICIPANTS = [
  'tem_hawks',
  'tem_owls',
  'tem_foxes',
  'tem_bears',
  'tem_wolves',
  'tem_lynx',
  'tem_elks'
]
export const EXHIBITION_TEAMS = ['tem_otters', 'tem_herons']

export const TEAM_NAMES: Record<string, string> = {
  tem_hawks: 'Demo Hawks',
  tem_owls: 'Demo Owls',
  tem_foxes: 'Demo Foxes',
  tem_bears: 'Demo Bears',
  tem_wolves: 'Demo Wolves',
  tem_lynx: 'Demo Lynx',
  tem_elks: 'Demo Elks',
  tem_otters: 'Demo Otters',
  tem_herons: 'Demo Herons'
}

/** The same hours on several weekdays. */
export function hoursOn(
  weekdays: number[],
  start: string,
  end: string
): WeekdayHours[] {
  return weekdays.map(weekday => ({ weekday, start, end }))
}

const WEEKDAYS = [1, 2, 3, 4, 5]
const SATURDAY = [6]

/** Field 1: weekday evenings 17:30–21:00 and Saturdays 08:00–18:00. */
export function field(changes: Partial<EngineField> = {}): EngineField {
  return {
    id: FIELD,
    name: 'Field 1',
    venueName: 'Demo Park',
    sizes: ['46/60', '50/70'],
    availability: {
      startsOn: '2026-10-01',
      endsOn: '2027-09-30',
      hours: [
        ...hoursOn(WEEKDAYS, '17:30', '21:00'),
        ...hoursOn(SATURDAY, '08:00', '18:00')
      ],
      blackouts: [],
      timezone: ZONE
    },
    switchMinutes: 30,
    ...changes
  }
}

/**
 * The E7 season: seven participants, 4 regular and 1 exhibition game each,
 * two exhibition teams, 90-minute games with 10 minutes between, March to
 * July, with a period from June 1 of weekdays 18:00–21:00.
 */
export function season(
  settings: Partial<EngineSeason['settings']> = {},
  changes: Partial<EngineSeason> = {}
): EngineSeason {
  return {
    id: SEASON,
    name: 'Demo Spring',
    participants: PARTICIPANTS,
    exhibitionTeams: EXHIBITION_TEAMS,
    ...changes,
    settings: {
      fieldSize: '50/70',
      gameMinutes: 90,
      bufferMinutes: 10,
      regularGames: 4,
      exhibitionGames: 1,
      doubleheaders: 'ifNecessary',
      startsOn: '2027-03-01',
      endsOn: '2027-07-31',
      blackouts: [],
      windows: [
        {
          from: '2027-03-01',
          hours: [
            ...hoursOn(WEEKDAYS, '17:30', '21:00'),
            ...hoursOn(SATURDAY, '08:00', '18:00')
          ]
        },
        {
          from: '2027-06-01',
          hours: [
            ...hoursOn(WEEKDAYS, '18:00', '21:00'),
            ...hoursOn(SATURDAY, '08:00', '18:00')
          ]
        }
      ],
      ...settings
    }
  }
}

/** A run of the given seasons and fields, from 2026-10-22. */
export function input(changes: Partial<EngineInput> = {}): EngineInput {
  return {
    seasons: [season()],
    fields: [field()],
    bookings: [],
    fixed: [],
    teamNames: TEAM_NAMES,
    notBefore: Date.parse('2026-10-22T05:00:00Z'),
    seed: 7,
    ...changes
  }
}

/** E10: Saturdays 08:00–18:00 only, and many regular games each. */
export function saturdaysInput(regularGames: number): EngineInput {
  const saturdays = hoursOn(SATURDAY, '08:00', '18:00')
  return input({
    seasons: [
      season({
        regularGames,
        windows: [{ from: '2027-03-01', hours: saturdays }]
      })
    ],
    fields: [
      field({
        availability: { ...field().availability, hours: saturdays }
      })
    ]
  })
}

/** A fixed game of the season at a Chicago wall time. */
export function fixedGame(
  key: string,
  home: string,
  away: string,
  startAt: string,
  minutes = 90,
  changes: Partial<FixedGame> = {}
): FixedGame {
  const start = Date.parse(startAt)
  return {
    key,
    seasonId: SEASON,
    homeTeamId: home,
    awayTeamId: away,
    exhibition: false,
    fieldId: FIELD,
    size: '50/70',
    start,
    end: start + minutes * 60_000,
    ...changes
  }
}

/** A value the test knows is there, or a failure saying it isn't. */
export function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a value')
  return value
}
