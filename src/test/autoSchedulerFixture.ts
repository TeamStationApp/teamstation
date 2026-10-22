import { userIdOfGumbo } from '../common/userId'
import { demoLocality, type GroupFixture, groupFixture } from './groupFixtures'

/** The season the scheduler builds: spring through July, on Eastern time. */
export const SEASON_TIMEZONE = 'America/New_York'
export const SEASON_STARTS_ON = '2027-03-01'
export const SEASON_ENDS_ON = '2027-07-31'

/** G1: the upcoming game every before-and-after shot of a game shows. */
export const G1 = 'gam_autoSchedulerG1'
export const G1_START = '2027-04-10T14:00:00.000Z'
export const G1_END = '2027-04-10T16:00:00.000Z'

/** Where the fixture's places sit on the map. */
export const DEMO_LATITUDE = 40.01
export const DEMO_LONGITUDE = -75.21

export const LEAGUE_MANAGED = [
  'Hawks',
  'Owls',
  'Foxes',
  'Comets',
  'Bears',
  'Rockets'
] as const
export const EXHIBITION = ['Otters', 'Herons'] as const

export interface AutoSchedulerFixture {
  f: GroupFixture
  /** Team ids by their short name, `Visitors` being the outside team. */
  teams: Record<string, string>
  /** The site administrator's fixture user. */
  siteAdmin: 105
  /** The outside team's admin. */
  outsideAdmin: 103
}

/**
 * The scheduler's world: leagueA's seasonA with seven participants (six the
 * league manages and one, the Visitors, that only competes), two more teams
 * that become exhibition teams, and G1. Everything here goes through tables
 * that exist on origin/master, so the same fixture runs on the base branch
 * for the before screenshots.
 */
export async function autoSchedulerFixture(
  webRoot?: string,
  options: { cityLookup?: Parameters<typeof groupFixture>[3] } = {}
): Promise<AutoSchedulerFixture> {
  const f = await groupFixture(
    webRoot,
    undefined,
    undefined,
    options.cityLookup
  )
  for (const [id, name] of [
    [101, 'Demo League Admin'],
    [102, 'Demo Neighbour Admin'],
    [103, 'Demo Visitors Admin'],
    [105, 'Demo Site Admin']
  ] as const)
    await f.h.db
      .updateTable('users')
      .set({ display_name: name, first_name: 'Demo', last_name: name.slice(5) })
      .where('id', '=', userIdOfGumbo(id))
      .execute()
  await f.h.db
    .updateTable('seasons')
    .set({
      starts_on: SEASON_STARTS_ON,
      ends_on: SEASON_ENDS_ON,
      timezone: SEASON_TIMEZONE
    })
    .where('id', '=', f.seasonA)
    .execute()
  // The account harness's own team is also called Demo Hawks; rename it so
  // the fixture's lists hold one Hawks.
  await f.h.db
    .updateTable('teams')
    .set({ name: 'Demo Practice Squad' })
    .where('id', '=', 'tem_account')
    .execute()
  const teams: Record<string, string> = {
    Hawks: f.teamA,
    Visitors: f.standaloneTeam
  }
  for (const name of [...LEAGUE_MANAGED.slice(1), ...EXHIBITION]) {
    const response = await f.h.request(
      'POST',
      '/teams',
      {
        name: `Demo ${name}`,
        idempotencyKey: `autoScheduler-${name}`,
        locality: demoLocality,
        parent: { kind: 'season', id: f.seasonA }
      },
      101
    )
    if (response.status !== 201)
      throw new Error(`The ${name} fixture team could not be created`)
    teams[name] = ((await response.json()) as { id: string }).id
  }
  // Every team competes in seasonA. The Visitors keep their own management,
  // so the league has no authority over them.
  for (const id of Object.values(teams))
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonA, team_id: id, active: true })
      .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
      .execute()
  await f.h.db
    .insertInto('games')
    .values({
      id: G1,
      home_team_id: teams.Owls,
      away_team_id: teams.Hawks,
      season_id: f.seasonA,
      start_at: new Date(G1_START),
      end_at: new Date(G1_END),
      timezone: SEASON_TIMEZONE,
      venue: 'Demo Park',
      address: '100 Demo Avenue, Demo City',
      // Set here so the Info tab's map never geocodes over the network.
      latitude: DEMO_LATITUDE,
      longitude: DEMO_LONGITUDE,
      status: 'scheduled'
    })
    .execute()
  return { f, teams, siteAdmin: 105, outsideAdmin: 103 }
}

/** Calls the API as a fixture user and returns the parsed answer. */
export async function api<T = unknown>(
  fx: AutoSchedulerFixture,
  user: number,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fx.f.h.request(method, path, body, user)
  const text = await response.text()
  if (!response.ok)
    throw new Error(`${method} ${path} as ${user}: ${response.status} ${text}`)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Field 1's weekly hours: weekday evenings and Saturdays. */
export const FIELD_ONE_HOURS = [
  { weekday: 1, start: '17:00', end: '21:00' },
  { weekday: 2, start: '17:00', end: '21:00' },
  { weekday: 3, start: '17:00', end: '21:00' },
  { weekday: 4, start: '17:00', end: '21:00' },
  { weekday: 5, start: '17:00', end: '21:00' },
  { weekday: 6, start: '08:00', end: '18:00' }
]

/** Example Park claimed by leagueA, its claim approved; returns its id. */
export async function seedClaimedPark(
  fx: AutoSchedulerFixture
): Promise<string> {
  const venue = await api<{ id: string }>(fx, 101, 'POST', '/venues', {
    placeId: 'example-park',
    leagueId: fx.f.leagueA
  })
  fx.f.advance(WEEK_MS)
  await api(fx, 101, 'GET', `/venues/${venue.id}`)
  return venue.id
}

/** Field 1 as E2 leaves it, and Field 2 deleted; returns Field 1's id. */
export async function seedFields(
  fx: AutoSchedulerFixture,
  venueId: string
): Promise<string> {
  const withOne = await api<{ fields: Array<{ id: string; name: string }> }>(
    fx,
    101,
    'POST',
    `/venues/${venueId}/fields`,
    {
      name: 'Field 1',
      sizes: ['46/60', '50/70'],
      startsOn: '2026-10-01',
      endsOn: '2027-09-30',
      hours: FIELD_ONE_HOURS
    }
  )
  const withTwo = await api<{ fields: Array<{ id: string; name: string }> }>(
    fx,
    101,
    'POST',
    `/venues/${venueId}/fields`,
    { name: 'Field 2', sizes: ['50/70', '55/80'] }
  )
  const two = withTwo.fields.find(field => field.name === 'Field 2')!
  await api(fx, 101, 'DELETE', `/venues/${venueId}/fields/${two.id}`)
  return withOne.fields.find(field => field.name === 'Field 1')!.id
}

/** The state the full pass reaches just before a scenario. */
export async function seedThrough(
  fx: AutoSchedulerFixture,
  scenario: string
): Promise<{ venueId?: string; fieldId?: string }> {
  const order = Number(scenario.slice(1))
  if (order < 2) return {}
  const venueId = await seedClaimedPark(fx)
  if (order < 3) return { venueId }
  const fieldId = await seedFields(fx, venueId)
  if (order < 5) return { venueId, fieldId }
  await seedGamesOnField(fx, venueId, fieldId)
  if (order < 7) return { venueId, fieldId }
  await seedSchedulingSetup(fx, fieldId)
  return { venueId, fieldId }
}

/** seasonA's game windows as E6 sets them: a second period from June 1. */
export const SEASON_A_WINDOWS = [
  {
    from: SEASON_STARTS_ON,
    hours: [
      ...[1, 2, 3, 4, 5].map(weekday => ({
        weekday,
        start: '17:30',
        end: '21:00'
      })),
      { weekday: 6, start: '08:00', end: '18:00' }
    ]
  },
  {
    from: '2027-06-01',
    hours: [
      ...[1, 2, 3, 4, 5].map(weekday => ({
        weekday,
        start: '18:00',
        end: '21:00'
      })),
      { weekday: 6, start: '08:00', end: '18:00' }
    ]
  }
]

/** seasonA's settings as E6 leaves them. */
export const SEASON_A_SETTINGS = {
  fieldSize: '50/70',
  gameMinutes: 90,
  bufferMinutes: 10,
  regularGames: 4,
  exhibitionGames: 1,
  doubleheaders: 'ifNecessary',
  startsOn: SEASON_STARTS_ON,
  endsOn: SEASON_ENDS_ON,
  blackouts: [],
  windows: SEASON_A_WINDOWS
}

/**
 * E6's state: the Otters and Herons flagged as exhibition teams, seasonA's
 * settings, and seasonA and Field 1 chosen for the run.
 */
export async function seedSchedulingSetup(
  fx: AutoSchedulerFixture,
  fieldId: string
): Promise<void> {
  for (const name of EXHIBITION)
    await api(
      fx,
      101,
      'PUT',
      `/seasons/${fx.f.seasonA}/memberships/${fx.teams[name]}`,
      { exhibition: true }
    )
  await api(
    fx,
    101,
    'PUT',
    `/seasons/${fx.f.seasonA}/schedule-settings`,
    SEASON_A_SETTINGS
  )
  await api(fx, 101, 'PUT', `/leagues/${fx.f.leagueA}/schedule-setup`, {
    seasonIds: [fx.f.seasonA],
    fieldIds: [fieldId]
  })
}

/** The second game E4 books: noon on G1's Saturday, in the other size. */
export const SECOND_START = '2027-04-10T16:00:00.000Z'
export const SECOND_END = '2027-04-10T18:00:00.000Z'

/**
 * E4's state: a 30-minute size switch, G1 on Field 1 at 50/70, and a second
 * game right after it at 46/60.
 */
export async function seedGamesOnField(
  fx: AutoSchedulerFixture,
  venueId: string,
  fieldId: string
): Promise<string> {
  await api(fx, 101, 'PUT', `/venues/${venueId}`, { sizeSwitchMinutes: 30 })
  const g1 = await api<{ game: Record<string, unknown>; version: string }>(
    fx,
    101,
    'GET',
    `/games/${G1}/scheduling`
  )
  await api(fx, 101, 'POST', '/game-requests', {
    sender: { kind: 'team', id: fx.teams.Hawks },
    gameId: G1,
    expected: g1.version,
    game: { ...g1.game, fieldId, fieldSize: '50/70' },
    idempotencyKey: 'seed-g1-field'
  })
  return await bookSecondGame(fx, fieldId)
}

/** The second game, booked through the API as the season. */
export async function bookSecondGame(
  fx: AutoSchedulerFixture,
  fieldId: string
): Promise<string> {
  const sent = await api<{ gameId: string }>(
    fx,
    101,
    'POST',
    '/game-requests',
    {
      sender: { kind: 'season', id: fx.f.seasonA },
      game: {
        homeTeamId: fx.teams.Comets,
        awayTeamId: fx.teams.Bears,
        seasonId: fx.f.seasonA,
        startAt: SECOND_START,
        endAt: SECOND_END,
        timezone: SEASON_TIMEZONE,
        venue: null,
        outsideTournament: null,
        status: 'scheduled',
        fieldId,
        fieldSize: '46/60'
      },
      idempotencyKey: 'seed-second-game'
    }
  )
  return sent.gameId
}
