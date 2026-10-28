import type { Kysely } from 'kysely'

import { asPostEventsBody, type GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { shortNames } from '../../common/names'
import type { ScoringAction } from '../../common/scoring/actions'
import { newSetup } from '../../common/scoring/lineup'
import type { DefaultLineup, Lineup } from '../../common/scoring/lineupHistory'
import { ScoringSession, type StoredGame } from '../../common/scoring/session'
import {
  type GameSetup,
  type GameTeam,
  type Position,
  POSITIONS,
  type Side
} from '../../common/scoring/state'
import type { UserId } from '../../common/userId'
import { MemoryStore, replayActions } from '../../test/replayGameFixture'
import { addEmail } from '../auth/emails'
import { hashPassword } from '../auth/passwords'
import type { Actor } from '../auth/sessions'
import { type Database, makeDatabase } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { createGuestPlayer } from '../games/guestPlayers'
import { createRelationshipRequest } from '../groups/requests'
import { grantAt, notifyGrant } from '../invites/grants'
import { serverConfig } from '../serverConfig'
import { ensureGumboId, insertUser } from '../users/insertUser'

/**
 * The data the player-name end-to-end scenarios run against, in a
 * development database, with major leaguers' names only:
 *
 * - a league, a season (with its date range) and two teams, the visitors
 *   run by two administrators who sign in (the second one makes the first
 *   deletable, since a team keeps one administrator), so the first play's
 *   batter, credited in the video's first highlight, is a player they
 *   manage;
 * - a game scored through a `ScoringSession` (the replay fixture's three
 *   innings: a steal, a wild pitch, a pitching change, a pinch hitter who
 *   stays in as a defensive switch, strikeouts), in which a game-only player
 *   pinch-hits for the last batter and strikes out;
 * - a second game whose plays an outside scorer posted, with a typed
 *   opponent (a batter with no id) and a ground out credited down a `to`
 *   fielding chain;
 * - a video of the scored game, whose plays it covers, so it has highlights;
 * - the administered team's default lineup;
 * - a player with a sign-in e-mail who can delete his account;
 * - a test account (a player of the administered team who signs in), asked
 *   by the first administrator to be his guardian, and made a coach of the
 *   team by the second.
 *
 *   node -r sucrase/register src/server/dev/namesFixture.ts [--password <pw>] > fixture.json
 *
 * Everyone signs in with an e-mail code, or with `--password` when given; the
 * password is never printed. Every run makes new people and groups, with
 * addresses stamped by the run, and prints every id and e-mail as JSON. It
 * refuses to run in production.
 */

interface Named {
  first: string
  last: string
  position?: Position
}

/** The visitors, in batting order, then the bench: the replay fixture's. */
const AWAY: Named[] = [
  { first: 'Juan', last: 'Soto', position: 'LF' },
  { first: 'Aaron', last: 'Judge', position: 'RF' },
  { first: 'Anthony', last: 'Rizzo', position: '1B' },
  { first: 'Gleyber', last: 'Torres', position: '2B' },
  { first: 'Anthony', last: 'Volpe', position: 'SS' },
  { first: 'Luis', last: 'Garcia', position: '3B' },
  { first: 'Jose', last: 'Trevino', position: 'C' },
  { first: 'Harrison', last: 'Bader', position: 'CF' },
  { first: 'Gerrit', last: 'Cole', position: 'P' },
  { first: 'Giancarlo', last: 'Stanton' },
  { first: 'Luis', last: 'Gil' }
]
/** The home side, in batting order, then the bench. */
const HOME: Named[] = [
  { first: 'Mookie', last: 'Betts', position: 'SS' },
  { first: 'Freddie', last: 'Freeman', position: '1B' },
  { first: 'Shohei', last: 'Ohtani', position: 'LF' },
  { first: 'Will', last: 'Smith', position: 'C' },
  { first: 'Max', last: 'Muncy', position: '3B' },
  { first: 'Teoscar', last: 'Hernandez', position: 'RF' },
  { first: 'Gavin', last: 'Lux', position: '2B' },
  { first: 'James', last: 'Outman', position: 'CF' },
  { first: 'Tyler', last: 'Glasnow', position: 'P' },
  { first: 'Evan', last: 'Phillips' }
]

/** The people who sign in, and the game-only player and typed opponent. */
export const NAMES_PEOPLE = {
  admin: { first: 'Joe', last: 'Torre' },
  secondAdmin: { first: 'Bobby', last: 'Cox' },
  testAccount: { first: 'Mike', last: 'Trout' },
  deletable: { first: 'Paul', last: 'Goldschmidt' },
  guest: { first: 'Ichiro', last: 'Suzuki' },
  typedOpponent: 'Clayton Kershaw'
} as const

const TEAM_NAMES: Record<Side, string> = {
  away: 'Lakeside Owls',
  home: 'Ridge Foxes'
}
/** The side the administrators run. */
const OURS: Side = 'away'

/** When the scored game starts; its video starts with it. */
const GAME_START = new Date('2026-09-26T17:00:00.000Z')
/** The outside scorer's game, a week before. */
const OUTSIDE_START = new Date('2026-09-19T17:00:00.000Z')

export interface FixturePlayer {
  userId: UserId
  gumboId: number
  name: string
  jersey: string
}

export interface FixturePerson {
  userId: UserId
  gumboId: number
  email: string
  name: string
}

export interface NamesFixture {
  leagueId: string
  seasonId: string
  teams: Record<Side, string>
  gameId: string
  outsideGameId: string
  videoId: string
  people: {
    admin: FixturePerson
    secondAdmin: FixturePerson
    testAccount: FixturePerson
    deletable: FixturePerson
  }
  guest: FixturePlayer
  typedOpponent: string
  players: Record<Side, FixturePlayer[]>
  guardianRequestId: string
  coachGrantId: string
}

type Db = Kysely<Database>

/** A person on a team: a rostered player, with a jersey and a position. */
async function rosterPlayer(
  db: Db,
  teamId: string,
  named: Named,
  jersey: string,
  login?: { email: string; passwordHash: string | null }
): Promise<{ userId: UserId; gumboId: number }> {
  const userId = await insertUser(db, {
    display_name: `${named.first} ${named.last}`,
    first_name: named.first,
    last_name: named.last,
    bats: 'right',
    throws: 'right',
    ...(login == null
      ? {}
      : { login_enabled: true, password_hash: login.passwordHash })
  })
  if (login != null)
    await addEmail(db, userId, login.email, {
      isPrimary: true,
      source: 'manual'
    })
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: userId,
      team_id: teamId,
      role: 'member',
      is_player: true,
      jersey,
      positions: named.position == null ? [] : [named.position]
    })
    .execute()
  return { userId, gumboId: await ensureGumboId(db, userId) }
}

/** An administrator of the team who signs in and does not play. */
async function administrator(
  db: Db,
  teamId: string,
  named: Named,
  email: string,
  passwordHash: string | null
): Promise<UserId> {
  const userId = await insertUser(db, {
    display_name: `${named.first} ${named.last}`,
    first_name: named.first,
    last_name: named.last,
    login_enabled: true,
    is_admin: false,
    password_hash: passwordHash
  })
  await addEmail(db, userId, email, { isPrimary: true, source: 'manual' })
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: userId,
      team_id: teamId,
      role: 'member'
    })
    .execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: userId,
      scope_type: 'team',
      scope_id: teamId,
      role: 'admin'
    })
    .execute()
  return userId
}

function actorOf(userId: UserId): Actor {
  return { userId, isAdmin: false, scopes: [] }
}

/**
 * Both lineups, as the scoring screen builds them from the rosters: short
 * names over each team, the batting order and the defence above, and the
 * game-only player on the visitors' bench under the whole name he was typed
 * with.
 */
function fixtureSetup(
  teams: Record<Side, GameTeam>,
  players: Record<Side, Array<FixturePlayer & Named>>,
  guest: FixturePlayer
): GameSetup {
  const setup = newSetup(
    teams,
    {
      away: players.away.map(p => ({
        gumboId: p.gumboId,
        shortName: p.name,
        jersey: p.jersey,
        positions: p.position == null ? [] : [p.position]
      })),
      home: players.home.map(p => ({
        gumboId: p.gumboId,
        shortName: p.name,
        jersey: p.jersey,
        positions: p.position == null ? [] : [p.position]
      }))
    },
    false
  )
  for (const side of ['away', 'home'] as const) {
    const team = setup.sides[side]
    for (const player of players[side]) {
      const record = setup.players[player.gumboId]
      record.firstName = player.first
      record.lastName = player.last
    }
    const starters = players[side].filter(p => p.position != null)
    team.battingOrder = starters.map(p => p.gumboId)
    team.battingIndex = 0
    for (const position of Object.keys(team.defense) as Position[])
      team.defense[position] = null
    for (const player of starters)
      team.defense[player.position!] = player.gumboId
  }
  setup.players[guest.gumboId] = {
    id: guest.gumboId,
    teamId: teams.away.id,
    fullName: guest.name,
    firstName: NAMES_PEOPLE.guest.first,
    lastName: NAMES_PEOPLE.guest.last,
    jersey: guest.jersey,
    bats: 'left',
    throws: 'right',
    positions: [],
    local: true
  }
  setup.sides.away.players.push(guest.gumboId)
  setup.tagOrder.push(guest.gumboId)
  return setup
}

/**
 * The replay fixture's game, with the game-only player pinch-hitting for the
 * last batter of the top of the 3rd, who strikes out to end the game.
 */
function fixtureActions(setup: GameSetup, guest: number): ScoringAction[] {
  const actions = replayActions(setup)
  // The game ends: three strikes, the close, then the end of the game.
  const lastAtBat = actions.length - 5
  const batter = setup.sides.away.players[2]
  return [
    ...actions.slice(0, lastAtBat),
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: guest,
      replaces: batter
    },
    ...actions.slice(lastAtBat)
  ]
}

/** Scores the game through a session, on a clock that moves on each look. */
async function scoreGame(
  gameId: string,
  teams: Record<Side, GameTeam>,
  setup: GameSetup,
  actions: ScoringAction[]
): Promise<StoredGame> {
  const store = new MemoryStore()
  let tick = 0
  const session = await ScoringSession.open(
    store,
    gameId,
    { gamePk: gameId, teams, setup },
    {
      // Five minutes in, then seven seconds a look, so every play has its
      // own moment in the video.
      now: () => new Date(GAME_START.getTime() + 300_000 + 7_000 * tick++),
      setTimer: () => null,
      clearTimer: () => undefined
    }
  )
  for (const [index, action] of actions.entries()) {
    const applied = session.apply(action)
    if (applied.problems.length > 0)
      throw new Error(
        `action ${index} ${JSON.stringify(action)}: ${applied.problems[0].message}`
      )
  }
  await session.flush()
  return store.stored()
}

/**
 * The outside scorer's plays: a typed opponent singles off the home pitcher,
 * and the next batter grounds out short to first, the credit's label naming
 * the fielders as the scorer sent them.
 */
function outsidePlays(
  teams: Record<Side, string>,
  ids: { glasnow: number; betts: number; freeman: number; soto: number },
  names: { glasnow: string; betts: string; freeman: string }
): GumboPlay[] {
  const at = (minutes: number): string =>
    new Date(OUTSIDE_START.getTime() + minutes * 60_000).toISOString()
  const typed = NAMES_PEOPLE.typedOpponent
  return [
    {
      about: {
        atBatIndex: 0,
        inning: 1,
        halfInning: 'top',
        isScoringPlay: false,
        startTime: at(5),
        endTime: at(6)
      },
      result: { eventType: 'single', awayScore: 0, homeScore: 0 },
      count: { outs: 0 },
      matchup: { batter: { fullName: typed }, pitcher: { id: ids.glasnow } },
      runners: [
        {
          movement: { start: null, end: '1B', isOut: false },
          details: { eventType: 'single', runner: { fullName: typed } }
        }
      ],
      credits: [
        {
          eventType: 'single',
          label: `Single: ${typed}`,
          credit: { name: typed, role: 'batter', position: null },
          teamId: teams.away,
          creditUserId: null
        }
      ]
    },
    {
      about: {
        atBatIndex: 1,
        inning: 1,
        halfInning: 'top',
        isScoringPlay: false,
        startTime: at(8),
        endTime: at(9)
      },
      result: { eventType: 'field_out', awayScore: 0, homeScore: 0 },
      count: { outs: 1 },
      matchup: { batter: { id: ids.soto }, pitcher: { id: ids.glasnow } },
      runners: [
        {
          movement: { start: null, end: null, isOut: true },
          details: { eventType: 'field_out', runner: { id: ids.soto } }
        },
        {
          movement: { start: '1B', end: '2B', isOut: false },
          details: { eventType: 'field_out', runner: { fullName: typed } }
        }
      ],
      credits: [
        {
          eventType: 'field_out',
          label: `Ground out: ${names.betts} (SS) to ${names.freeman} (1B)`,
          credit: { name: names.betts, role: 'fielder', position: 'SS' },
          teamId: teams.home,
          creditUserId: ids.betts,
          assists: [
            {
              name: names.freeman,
              position: '1B',
              creditUserId: ids.freeman
            }
          ]
        }
      ]
    }
  ] as unknown as GumboPlay[]
}

/** Makes the fixture in `db`. */
export async function createNamesFixture(
  db: Db,
  options: { password?: string; stamp?: string } = {}
): Promise<NamesFixture> {
  const stamp = options.stamp ?? Date.now().toString(36)
  const passwordHash =
    options.password == null ? null : await hashPassword(options.password)
  const email = (who: string): string =>
    `names.${who.toLowerCase()}.${stamp}@example.test`

  const leagueId = makeId('league')
  const seasonId = makeId('season')
  const teams: Record<Side, string> = {
    away: makeId('team'),
    home: makeId('team')
  }
  await db
    .insertInto('leagues')
    .values({ id: leagueId, name: `Names League ${stamp}`, short_name: 'NAM' })
    .execute()
  await db
    .insertInto('seasons')
    .values({
      id: seasonId,
      league_id: leagueId,
      name: 'Names Season 2026',
      year: 2026,
      term: 'Fall',
      starts_on: '2026-03-01',
      ends_on: '2026-11-30'
    })
    .execute()
  await db
    .insertInto('teams')
    .values([
      { id: teams.away, name: TEAM_NAMES.away },
      { id: teams.home, name: TEAM_NAMES.home }
    ])
    .execute()
  await db
    .insertInto('season_teams')
    .values([
      { season_id: seasonId, team_id: teams.away },
      { season_id: seasonId, team_id: teams.home }
    ])
    .execute()

  // Each team's players, named by short names over the team, as its roster
  // names them.
  const players: Record<Side, Array<FixturePlayer & Named>> = {
    away: [],
    home: []
  }
  for (const [side, list] of [
    ['away', AWAY],
    ['home', HOME]
  ] as const) {
    const made: Array<{ userId: UserId; gumboId: number; jersey: string }> = []
    for (const [index, named] of list.entries()) {
      const jersey = String(index + (side === 'away' ? 1 : 21))
      made.push({
        ...(await rosterPlayer(db, teams[side], named, jersey)),
        jersey
      })
    }
    const short = shortNames(
      list.map((named, i) => ({
        id: made[i].userId,
        firstName: named.first,
        lastName: named.last,
        displayName: `${named.first} ${named.last}`
      }))
    )
    players[side] = list.map((named, i) => ({
      ...named,
      ...made[i],
      name: short.get(made[i].userId)!
    }))
  }

  const person = async (
    key: 'admin' | 'secondAdmin' | 'testAccount' | 'deletable',
    userId: UserId
  ): Promise<FixturePerson> => ({
    userId,
    gumboId: await ensureGumboId(db, userId),
    email: email(key),
    name: `${NAMES_PEOPLE[key].first} ${NAMES_PEOPLE[key].last}`
  })
  const admin = await person(
    'admin',
    await administrator(
      db,
      teams[OURS],
      NAMES_PEOPLE.admin,
      email('admin'),
      passwordHash
    )
  )
  const secondAdmin = await person(
    'secondAdmin',
    await administrator(
      db,
      teams[OURS],
      NAMES_PEOPLE.secondAdmin,
      email('secondAdmin'),
      passwordHash
    )
  )
  const testAccount = await person(
    'testAccount',
    (
      await rosterPlayer(db, teams[OURS], NAMES_PEOPLE.testAccount, '27', {
        email: email('testAccount'),
        passwordHash
      })
    ).userId
  )
  const deletable = await person(
    'deletable',
    (
      await rosterPlayer(db, teams[OURS], NAMES_PEOPLE.deletable, '46', {
        email: email('deletable'),
        passwordHash
      })
    ).userId
  )

  // The scored game, with the game-only player made for it first: a game
  // that is over takes no new players.
  const gameId = makeId('game')
  await db
    .insertInto('games')
    .values({
      id: gameId,
      home_team_id: teams.home,
      away_team_id: teams.away,
      season_id: seasonId,
      start_at: GAME_START,
      venue: 'Names Field',
      status: 'scheduled'
    })
    .execute()
  const guestEntry = await createGuestPlayer(
    db,
    actorOf(admin.userId),
    gameId,
    'away',
    {
      firstName: NAMES_PEOPLE.guest.first,
      lastName: NAMES_PEOPLE.guest.last,
      jersey: '51',
      positions: [],
      bats: 'left',
      throws: 'right'
    }
  )
  const guest: FixturePlayer = {
    userId: guestEntry.userId,
    gumboId: guestEntry.gumboId!,
    name: guestEntry.shortName,
    jersey: '51'
  }
  const gameTeams: Record<Side, GameTeam> = {
    away: { id: teams.away, name: TEAM_NAMES.away },
    home: { id: teams.home, name: TEAM_NAMES.home }
  }
  const setup = fixtureSetup(gameTeams, players, guest)
  const scored = await scoreGame(
    gameId,
    gameTeams,
    setup,
    fixtureActions(setup, guest.gumboId)
  )
  await postGamePlays(
    db,
    gameId,
    asPostEventsBody({
      plays: scored.plays,
      currentPlay: scored.currentPlay,
      mode: 'live',
      source: { system: 'teamstation' }
    })
  )

  // The outside scorer's game.
  const outsideGameId = makeId('game')
  await db
    .insertInto('games')
    .values({
      id: outsideGameId,
      home_team_id: teams.home,
      away_team_id: teams.away,
      season_id: seasonId,
      start_at: OUTSIDE_START,
      venue: 'Names Field',
      status: 'scheduled'
    })
    .execute()
  const byLast = (side: Side, last: string): FixturePlayer & Named =>
    players[side].find(p => p.last === last)!
  const glasnow = byLast('home', 'Glasnow')
  const betts = byLast('home', 'Betts')
  const freeman = byLast('home', 'Freeman')
  const soto = byLast('away', 'Soto')
  await postGamePlays(
    db,
    outsideGameId,
    asPostEventsBody({
      plays: outsidePlays(
        teams,
        {
          glasnow: glasnow.gumboId,
          betts: betts.gumboId,
          freeman: freeman.gumboId,
          soto: soto.gumboId
        },
        { glasnow: glasnow.name, betts: betts.name, freeman: freeman.name }
      ),
      source: { system: 'gameChanger' }
    })
  )

  // The scored game's video, from the first pitch to well after the last.
  const videoId = makeId('video')
  await db
    .insertInto('videos')
    .values({
      id: videoId,
      game_id: gameId,
      kind: 'program',
      title: `${TEAM_NAMES.away} at ${TEAM_NAMES.home}`,
      storage: 'local',
      status: 'ready',
      start_at: GAME_START,
      start_at_source: 'manual',
      duration_sec: 3 * 3600
    })
    .execute()

  // The administered team's default lineup: its nine starters, batting one
  // to nine.
  const starters = players[OURS].filter(p => p.position != null)
  const lineupPeople = starters.map(p => ({
    gumboId: p.gumboId,
    name: p.name,
    jersey: p.jersey
  }))
  const defaultLineup: DefaultLineup = {
    lineup: {
      batters: lineupPeople,
      defense: Object.fromEntries(
        POSITIONS.map(position => [
          position,
          lineupPeople[starters.findIndex(p => p.position === position)] ?? null
        ])
      ) as Lineup['defense']
    },
    fromGameId: null,
    setAt: new Date().toISOString()
  }
  await db
    .updateTable('teams')
    .set({ default_lineup: defaultLineup })
    .where('id', '=', teams[OURS])
    .execute()

  // The first administrator asks to be the test account's guardian; the
  // second makes the test account a coach of the team.
  const asked = await createRelationshipRequest(db, actorOf(admin.userId), {
    terms: {
      kind: 'guardian',
      playerUserId: testAccount.userId,
      guardian: { userId: admin.userId }
    },
    idempotencyKey: `names-guardian-${stamp}`
  })
  const ref = { kind: 'team' as const, id: teams[OURS] }
  const added = await grantAt(
    db,
    ref,
    testAccount.userId,
    ['coach'],
    secondAdmin.userId
  )
  const coachGrantId = await notifyGrant(db, {
    ref,
    userId: testAccount.userId,
    added,
    actorId: secondAdmin.userId
  })
  if (coachGrantId == null) throw new Error('The coach grant was not new')

  const strip = ({
    userId,
    gumboId,
    name,
    jersey
  }: FixturePlayer): FixturePlayer => ({ userId, gumboId, name, jersey })
  return {
    leagueId,
    seasonId,
    teams,
    gameId,
    outsideGameId,
    videoId,
    people: { admin, secondAdmin, testAccount, deletable },
    guest,
    typedOpponent: NAMES_PEOPLE.typedOpponent,
    players: {
      away: players.away.map(strip),
      home: players.home.map(strip)
    },
    guardianRequestId: asked.id,
    coachGrantId
  }
}

/**
 * Runs the command line against `db`, printing the fixture to `print`.
 * Refuses to run in production, and throws the usage for any other
 * arguments than `--password <password>`.
 */
export async function runNamesFixture(
  db: Db,
  args: string[],
  print: (text: string) => void
): Promise<NamesFixture> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('The names fixture does not run in production')
  const at = args.indexOf('--password')
  const password = at < 0 ? undefined : args[at + 1]
  if (
    (at >= 0 && (password == null || password === '')) ||
    args.length !== (at < 0 ? 0 : 2)
  )
    throw new Error(
      'Usage: node -r sucrase/register src/server/dev/namesFixture.ts [--password <password>]'
    )
  const fixture = await createNamesFixture(db, { password })
  print(JSON.stringify(fixture, null, 2))
  return fixture
}

/* c8 ignore start */
async function main(): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    await runNamesFixture(db, process.argv.slice(2), text => {
      console.log(text)
    })
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/namesFixture.ts') || entry.endsWith('/namesFixture.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
/* c8 ignore stop */
