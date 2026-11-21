import type {
  EngineField,
  EngineInput,
  EngineSeason
} from '../common/autoScheduler/types'
import type { WeekdayHours } from '../common/venues'
import type { WindowPeriod } from '../common/windowPeriods'

/**
 * A synthetic league packed to its field time, the shape of a real one with
 * every name invented: six seasons on five fields, one field shared by two
 * seasons, two unlit fields that close at sunset, six managers coaching in
 * two seasons, weekday and weekend maximums, an Easter Saturday and the week
 * after it blacked out, and a daylight-saving change on March 14.
 *
 * Settled exactly it gives S1 10, S2 10, S3 12, S4 14, S5 16 and S6 16 games
 * per team: S5 is held by field time, S6 by its weekly maximums.
 */

const SUN = 0
const SAT = 6
const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [SUN, ...WEEKDAYS, SAT]

function days(
  weekdays: readonly number[],
  start: string,
  end: string
): WeekdayHours[] {
  return weekdays.map(weekday => ({ weekday, start, end }))
}

/** A lit field: open from 07:00 every day to its own closing times. */
function lit(weekday: string, weekend: string): EngineField['availability'] {
  const hours = [
    ...days([SUN], '07:00', weekend),
    ...days(WEEKDAYS, '07:00', weekday),
    ...days([SAT], '07:00', weekend)
  ]
  return {
    startsOn: null,
    endsOn: null,
    hours,
    windows: [{ from: '0001-01-01', hours }],
    blackouts: [],
    timezone: 'America/Los_Angeles'
  }
}

/** An unlit field: open from 07:00 to sunset, before and after the clock change. */
function unlit(): EngineField['availability'] {
  const winter = [
    ...days([SUN, 1], '07:00', '17:40'),
    ...days([2, 3, 4, 5], '07:00', '17:45'),
    ...days([SAT], '07:00', '17:40')
  ]
  const summer = days(EVERY_DAY, '07:00', '18:55')
  return {
    startsOn: null,
    endsOn: null,
    hours: winter,
    windows: [
      { from: '0001-01-01', until: '2027-03-13', hours: winter },
      { from: '2027-03-14', hours: summer }
    ],
    blackouts: [],
    timezone: 'America/Los_Angeles'
  }
}

const FIELDS: EngineField[] = [
  {
    id: 'fld_f1',
    name: 'F1',
    venueName: 'Park',
    sizes: ['T-ball'],
    availability: lit('18:30', '18:30'),
    switchMinutes: 0
  },
  {
    id: 'fld_f2',
    name: 'F2',
    venueName: 'Park',
    sizes: ['46/60'],
    availability: unlit(),
    switchMinutes: 0
  },
  {
    id: 'fld_f3',
    name: 'F3',
    venueName: 'Park',
    sizes: ['46/60'],
    availability: lit('19:30', '19:30'),
    switchMinutes: 0
  },
  {
    id: 'fld_f4',
    name: 'F4',
    venueName: 'Park',
    sizes: ['46/60'],
    availability: unlit(),
    switchMinutes: 0
  },
  {
    id: 'fld_f5',
    name: 'F5',
    venueName: 'Park',
    sizes: ['46/60'],
    availability: lit('20:00', '19:30'),
    switchMinutes: 0
  }
]

interface SeasonShape {
  name: string
  teams: number
  field: string
  size: '46/60' | 'T-ball'
  game: number
  buffer: number
  requested: number
  weekdayMax: number
  hours: WeekdayHours[]
}

const SHAPES: SeasonShape[] = [
  {
    name: 'S1',
    teams: 6,
    field: 'fld_f1',
    size: 'T-ball',
    game: 60,
    buffer: 15,
    requested: 10,
    weekdayMax: 0,
    hours: days([SAT], '08:30', '21:00')
  },
  {
    name: 'S2',
    teams: 8,
    field: 'fld_f1',
    size: 'T-ball',
    game: 60,
    buffer: 30,
    requested: 10,
    weekdayMax: 0,
    hours: days([SAT], '12:30', '21:00')
  },
  {
    name: 'S3',
    teams: 10,
    field: 'fld_f2',
    size: '46/60',
    game: 90,
    buffer: 30,
    requested: 12,
    weekdayMax: 1,
    hours: [...days([1, 3], '16:45', '21:00'), ...days([SAT], '08:30', '21:00')]
  },
  {
    name: 'S4',
    teams: 8,
    field: 'fld_f3',
    size: '46/60',
    game: 120,
    buffer: 30,
    requested: 14,
    weekdayMax: 1,
    hours: [...days([2, 4], '17:00', '21:00'), ...days([SAT], '09:00', '21:00')]
  },
  {
    name: 'S5',
    teams: 10,
    field: 'fld_f4',
    size: '46/60',
    game: 120,
    buffer: 15,
    requested: 18,
    weekdayMax: 1,
    hours: [
      ...days(WEEKDAYS, '16:45', '21:00'),
      ...days([SAT], '07:30', '21:00')
    ]
  },
  {
    name: 'S6',
    teams: 9,
    field: 'fld_f5',
    size: '46/60',
    game: 120,
    buffer: 30,
    requested: 18,
    weekdayMax: 1,
    hours: [
      ...days(WEEKDAYS, '17:30', '21:00'),
      ...days([SAT], '09:30', '21:00')
    ]
  }
]

/** The teams that share a manager, by season and team number. */
const SHARED: Array<[[number, number], [number, number]]> = [
  [
    [0, 3],
    [2, 9]
  ],
  [
    [0, 6],
    [2, 8]
  ],
  [
    [1, 1],
    [4, 5]
  ],
  [
    [1, 2],
    [3, 4]
  ],
  [
    [2, 2],
    [4, 4]
  ],
  [
    [3, 2],
    [4, 8]
  ]
]

const BLACKOUTS = [
  '2027-03-27',
  '2027-03-29',
  '2027-03-30',
  '2027-03-31',
  '2027-04-01',
  '2027-04-02'
]

export const teamId = (season: number, team: number): string =>
  `tem_s${season + 1}t${team}`

/** The synthetic packed league as an engine input, every season in the run. */
export function packedLeagueRun(
  overrides: { seasons?: (season: EngineSeason) => EngineSeason } = {}
): EngineInput {
  const teamNames: Record<string, string> = {}
  const headCoaches: Record<string, string> = {}
  const seasons = SHAPES.map((shape, s): EngineSeason => {
    const participants = Array.from({ length: shape.teams }, (_, t) =>
      teamId(s, t + 1)
    )
    participants.forEach((team, t) => {
      teamNames[team] = `${shape.name} Team ${t + 1}`
      headCoaches[team] = `coach:${shape.name}:${t + 1}`
    })
    const windows: WindowPeriod[] = [
      { from: '2027-02-27', until: '2027-05-08', hours: shape.hours }
    ]
    return {
      id: `sea_${shape.name.toLowerCase()}`,
      name: shape.name,
      participants,
      exhibitionTeams: [],
      settings: {
        fieldIds: [shape.field],
        fieldSize: shape.size,
        gameMinutes: shape.game,
        bufferMinutes: shape.buffer,
        regularGames: shape.requested,
        exhibitionGames: 0,
        doubleheaders: 'never',
        maxGamesOnWeekdays: shape.weekdayMax,
        maxGamesOnWeekend: 1,
        preferGameOn: 'weekend',
        startsOn: '2027-02-27',
        endsOn: '2027-05-08',
        blackouts: BLACKOUTS,
        windows
      }
    }
  })
  for (const [[sa, ta], [sb, tb]] of SHARED)
    headCoaches[teamId(sb, tb)] = headCoaches[teamId(sa, ta)]
  return {
    headCoaches,
    seasons: seasons.map(overrides.seasons ?? (season => season)),
    fields: FIELDS.map(field => ({ ...field })),
    bookings: [],
    fixed: [],
    weeklyGames: [],
    teamNames,
    notBefore: Date.parse('2026-11-16T08:00:00Z'),
    seed: 1
  }
}
