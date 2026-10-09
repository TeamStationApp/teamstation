/**
 * A team with a season either side of today, for the team screen's
 * end-to-end tests: the browser run answers the app's API from this, and the
 * device run serves it over HTTP to the phone.
 *
 * Every name is invented. The dates are relative to the run's `now`, so the
 * next game is always the same row whatever day the test runs: eight games
 * behind, six ahead, a week apart, home and away in turn.
 */

export const TEAM_ID = 'tem_mudcats'
export const TEAM_NAME = 'Mudcats'
export const SEASON_ID = 'sea_mudcats'

const DAY = 24 * 60 * 60 * 1000

/** Furthest back first; the last of these is a week before `now`. */
const BEHIND = [
  'Cranes',
  'Bisons',
  'Otters',
  'Herons',
  'Foxes',
  'Badgers',
  'Hawks',
  'Owls'
]
/** Soonest first; the first of these is a week after `now`. */
const AHEAD = ['Falcons', 'Pelicans', 'Ravens', 'Comets', 'Lynx', 'Marlins']

/**
 * Which season the fixture answers with. `normal` has eight games behind and
 * six ahead. `live` has the same, with the last of the eight (`@ Owls`)
 * being played now. `over` moves the whole season into the past, and `empty`
 * has no games.
 */
export type FixtureSeason = 'normal' | 'live' | 'over' | 'empty'

/** The row the schedule opens on, and the one just above it. */
export const NEXT_ROW = 'vs Falcons'
export const PREVIOUS_ROW = '@ Owls'
/** The first game of the season, the top of the list. */
export const FIRST_ROW = 'vs Cranes'
/** The row a finished season opens on: its last game. */
export const LAST_ROW = '@ Marlins'

export interface FixtureGame {
  id: string
  homeTeamId: string
  awayTeamId: string
  homeTeamName: string
  awayTeamName: string
  seasonId: string
  startAt: string
  venue: string
  status: string
  homeScore: number | null
  awayScore: number | null
  ingestStatus: string
  videoCount: number
  durationSec: number | null
  posterUrl: null
}

function opponentId(name: string): string {
  return `tem_${name.toLowerCase()}`
}

/**
 * The season, in date order. Home and away alternate so both labels appear
 * next to each other: the game just before `now` is away, the one after it
 * at home.
 */
export function teamScheduleGames(
  now: number,
  season: FixtureSeason = 'normal'
): FixtureGame[] {
  if (season === 'empty') return []
  // Over: the same fourteen games, all a week apart and all behind.
  const shift = season === 'over' ? -(AHEAD.length + 1) * 7 * DAY : 0
  const all = [
    ...BEHIND.map((name, index) => ({
      name,
      at: now + shift - (BEHIND.length - index) * 7 * DAY,
      played: true
    })),
    ...AHEAD.map((name, index) => ({
      name,
      at: now + shift + (index + 1) * 7 * DAY,
      played: season === 'over'
    }))
  ]
  return all.map(({ name, at, played: done }, index) => {
    // Even rows at home, odd rows away: Cranes (0) at home, Owls (7) away,
    // Falcons (8) at home.
    const home = index % 2 === 0
    // Live: the Owls game began an hour ago and is being scored.
    const live = season === 'live' && index === BEHIND.length - 1
    const played = done && !live
    return {
      id: `gam_mudcats${String(index + 1).padStart(2, '0')}`,
      homeTeamId: home ? TEAM_ID : opponentId(name),
      awayTeamId: home ? opponentId(name) : TEAM_ID,
      homeTeamName: home ? TEAM_NAME : name,
      awayTeamName: home ? name : TEAM_NAME,
      seasonId: SEASON_ID,
      startAt: new Date(live ? now - 60 * 60 * 1000 : at).toISOString(),
      venue: home ? 'Riverside Park' : `${name} Field`,
      status: live ? 'inProgress' : played ? 'final' : 'scheduled',
      homeScore: played ? 3 + (index % 4) : null,
      awayScore: played ? 2 + (index % 3) : null,
      ingestStatus: played ? 'done' : 'pending',
      videoCount: played && index % 3 === 0 ? 1 : 0,
      durationSec: played && index % 3 === 0 ? 5400 : null,
      posterUrl: null
    }
  })
}

const USER = {
  id: 7,
  displayName: 'Pat',
  email: 'pat@example.com',
  isAdmin: false,
  avatarUrl: null
}

const TEAM = {
  id: TEAM_ID,
  name: TEAM_NAME,
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: { w: 5, l: 3, t: 0, seasonName: 'Spring' },
  kind: 'full'
}

/** Players by their real MLB names, as `AGENTS.md` asks of test data. */
const PLAYERS = [
  ['Mookie B.', '50', ['RF']],
  ['Freddie F.', '5', ['1B']],
  ['Shohei O.', '17', ['P', 'DH']],
  ['Aaron J.', '99', ['CF']],
  ['Juan S.', '22', ['LF']],
  ['Bobby W.', '7', ['SS']],
  ['Jose R.', '11', ['3B']],
  ['Corbin C.', '7', ['SS']],
  ['Gunnar H.', '2', ['SS']],
  ['Kyle T.', '12', ['RF']],
  ['Adley R.', '35', ['C']],
  ['Tarik S.', '27', ['P']],
  ['Zack W.', '45', ['P']],
  ['Logan W.', '22', ['P']]
] as const
const COACHES = ['Dave R.', 'Rob T.', 'Brian S.']
const FOLLOWERS = ['Alex B.', 'Ichiro S.', 'Cal R.']

interface Person {
  shortName: string
  jersey: string | null
  group: 'coach' | 'player' | 'follower'
  positions: string[]
}

const ROSTER = [
  ...COACHES.map((shortName): Person => ({
    shortName,
    jersey: null,
    group: 'coach',
    positions: []
  })),
  ...PLAYERS.map(([shortName, jersey, positions]): Person => ({
    shortName,
    jersey,
    group: 'player',
    positions: [...positions]
  })),
  ...FOLLOWERS.map((shortName): Person => ({
    shortName,
    jersey: null,
    group: 'follower',
    positions: []
  }))
].map((person, index) => ({
  ...person,
  userId: 100 + index,
  avatarUrl: null,
  isPlayer: person.group === 'player',
  role: person.group,
  bats: null,
  throws: null,
  walkUpSong: null
}))

const BATTING = PLAYERS.map(([shortName], index) => {
  const ab = 20 + index
  const h = 5 + (index % 7)
  return {
    userId: 103 + index,
    shortName,
    teamId: TEAM_ID,
    g: 8,
    pa: ab + 3,
    ab,
    h,
    singles: h - 2,
    doubles: 1,
    triples: 0,
    hr: 1,
    bb: 3,
    k: 4 + (index % 3),
    r: 3,
    hbp: 0,
    rbi: 2 + (index % 4),
    sb: index % 2,
    cs: 0,
    sf: 0,
    sh: 0,
    roe: 0,
    fc: 0,
    pik: 0,
    rates: { avg: h / ab, obp: (h + 3) / (ab + 3), slg: (h + 4) / ab },
    seasonAvg: h / ab
  }
})

const PITCHING = PLAYERS.filter(([, , positions]) =>
  (positions as readonly string[]).includes('P')
).map(([shortName], index) => ({
  userId: 200 + index,
  shortName,
  teamId: TEAM_ID,
  ip: `${8 + index}.1`,
  g: 4,
  outs: (8 + index) * 3 + 1,
  bf: 40 + index,
  h: 7 + index,
  hr: 1,
  hbp: 1,
  r: 4,
  er: 3,
  bb: 5,
  k: 11 + index,
  rates: { era: 2.4 + index / 10, whip: 1.2 }
}))

export interface FixtureAnswer {
  status: number
  body: unknown
}

/**
 * The answer to one API request, by path under `/api/v1`.
 *
 * Anything the team screen does not need — the home screen's lists, the
 * live strip — gets an empty list and is reported through `onUnknown`, so a
 * run that opens somewhere else says where it went.
 */
export function teamScheduleAnswer(
  method: string,
  path: string,
  now: number,
  onUnknown: (method: string, path: string) => void = () => undefined,
  season: FixtureSeason = 'normal'
): FixtureAnswer {
  const url = new URL(path, 'http://fixture.example.test')
  const route = url.pathname.replace(/^\/api\/v1/, '')
  if (method !== 'GET') {
    onUnknown(method, route)
    return { status: 404, body: { error: 'not found' } }
  }
  switch (route) {
    case '/auth/me':
      return { status: 200, body: USER }
    case '/me/roles':
      return { status: 200, body: { teams: {} } }
    case '/teams':
      return { status: 200, body: [TEAM] }
    case `/teams/${TEAM_ID}/games`:
      return { status: 200, body: teamScheduleGames(now, season) }
    case `/teams/${TEAM_ID}/roster`:
      return { status: 200, body: ROSTER }
    case `/teams/${TEAM_ID}/stats`:
      return {
        status: 200,
        body: url.searchParams.get('kind') === 'pitching' ? PITCHING : BATTING
      }
    case '/events':
      // The nav bar's Schedule: the same season, as season games.
      return {
        status: 200,
        body: teamScheduleGames(now, season).map(game => ({
          ...game,
          homeTeamExternal: false,
          awayTeamExternal: false,
          homeLogoUrl: null,
          awayLogoUrl: null,
          isLive: false,
          externalIds: []
        }))
      }
    case `/seasons/${SEASON_ID}/standings`:
      return {
        status: 200,
        body: [
          {
            teamId: TEAM_ID,
            teamName: TEAM_NAME,
            w: 5,
            l: 3,
            t: 0,
            runsFor: 41,
            runsAgainst: 30,
            played: 8,
            winningPct: 0.625,
            runDifferential: 11
          }
        ]
      }
    case '/invites':
      // The manage gear shows for somebody who may invite.
      return { status: 200, body: { canInvite: true, invites: [] } }
    default:
      onUnknown(method, route)
      return { status: 200, body: [] }
  }
}
