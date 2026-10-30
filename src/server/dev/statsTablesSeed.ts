import { randomBytes } from 'node:crypto'

import type { Kysely } from 'kysely'

import { asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { ScoringAction } from '../../common/scoring/actions'
import type { UserId } from '../../common/userId'
import {
  AWAY_PLAYERS,
  HOME_PLAYERS,
  type Player,
  REPLAY_TEAMS,
  replaySetup,
  scored
} from '../../test/replayGameFixture'
import { createEmailCode } from '../auth/emailCodes'
import { addEmail, findUserByEmail } from '../auth/emails'
import { type Database, makeDatabase } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { serverConfig } from '../serverConfig'
import { drain } from '../statsBuilder/builder'
import { ensureGumboId, insertUser } from '../users/insertUser'
import { REPLAY_SEED, seedReplay } from './replaySeed'

/**
 * The stats tables' end-to-end fixture, in a development database, on top of
 * the replay seed's league, teams and players:
 *
 * - Mookie Betts, of the replay's Valley Pines, also has stored lines for two
 *   teams both called Hawks (one in Spring 2026, one in Fall 2025) and for
 *   the Ravens (Fall 2025), two of the Spring games sharing a start, and a
 *   Summer 2024 game with a stored row and no line, so that season is offered
 *   in his filter and answers with nothing.
 * - A game nine innings long between the replay's two teams, scored play by
 *   play and still in progress, for a line score wider than a phone and a
 *   replay that opens at its end.
 * - A site administrator to read it all, who also coaches Valley Pines, so
 *   the Coach Game box score opens, and a sign-in token to spend as them.
 *
 * The replay seed's finished game is the box score with a pitching change.
 *
 *   node -r sucrase/register src/server/dev/statsTablesSeed.ts [--token]
 *
 * A new sign-in code voids the reader's earlier unused one, so each sign-in
 * needs its own: `--token` mints one more, without seeding, and prints it.
 * `TS_SEED_PASSWORD` keeps the replay seed's accounts on a known password.
 *
 * Everything it owns has a fixed id and is rebuilt on every run. It refuses
 * to run in production.
 */
export const STATS_TABLES_SEED = {
  email: 'stats-tables@example.test',
  seasons: {
    spring: 'sea_statsTablesSpring2026',
    fall: 'sea_statsTablesFall2025',
    summer: 'sea_statsTablesSummer2024'
  },
  teams: {
    hawksSpring: 'tem_statsTablesHawksSpring',
    hawksFall: 'tem_statsTablesHawksFall',
    ravens: 'tem_statsTablesRavens',
    owls: 'tem_statsTablesOwls'
  },
  nineInnings: 'gam_statsTablesNine'
} as const

export interface StatsTablesSeed {
  playerId: UserId
  readerId: UserId
  teams: typeof STATS_TABLES_SEED.teams
  seasons: typeof STATS_TABLES_SEED.seasons
  boxScoreGame: string
  coachTeam: string
  nineInnings: string
  token: string
}

type Db = Kysely<Database>

/** One of his stored games: who it was for, against whom, and his line. */
interface Line {
  id: string
  season: string
  team: string
  opponent: string
  home: boolean
  start: string
  batting?: { pa: number; ab: number; h: number; bb: number; rbi: number }
  /** Outs recorded, and earned runs. */
  pitching?: { outs: number; er: number }
}

const { seasons, teams } = STATS_TABLES_SEED
const LINES: Line[] = [
  {
    id: 'gam_statsTablesSpring1',
    season: seasons.spring,
    team: teams.hawksSpring,
    opponent: teams.owls,
    home: true,
    start: '2026-05-16T18:00:00Z',
    batting: { pa: 4, ab: 3, h: 2, bb: 1, rbi: 1 },
    pitching: { outs: 6, er: 1 }
  },
  {
    id: 'gam_statsTablesSpring2',
    season: seasons.spring,
    team: teams.hawksSpring,
    opponent: teams.owls,
    home: false,
    start: '2026-05-23T18:00:00Z',
    batting: { pa: 3, ab: 3, h: 1, bb: 0, rbi: 0 }
  },
  {
    id: 'gam_statsTablesSpring3',
    season: seasons.spring,
    team: teams.hawksSpring,
    opponent: teams.ravens,
    home: true,
    start: '2026-05-23T18:00:00Z',
    batting: { pa: 4, ab: 4, h: 0, bb: 0, rbi: 0 },
    pitching: { outs: 4, er: 0 }
  },
  {
    id: 'gam_statsTablesFall1',
    season: seasons.fall,
    team: teams.hawksFall,
    opponent: teams.owls,
    home: true,
    start: '2025-10-04T18:00:00Z',
    batting: { pa: 4, ab: 4, h: 3, bb: 0, rbi: 2 },
    pitching: { outs: 5, er: 2 }
  },
  {
    id: 'gam_statsTablesFall2',
    season: seasons.fall,
    team: teams.ravens,
    opponent: teams.owls,
    home: false,
    start: '2025-10-11T18:00:00Z',
    batting: { pa: 5, ab: 4, h: 1, bb: 1, rbi: 1 }
  },
  {
    id: 'gam_statsTablesFall3',
    season: seasons.fall,
    team: teams.ravens,
    opponent: teams.hawksFall,
    home: true,
    start: '2025-10-18T18:00:00Z',
    batting: { pa: 3, ab: 2, h: 1, bb: 1, rbi: 0 },
    pitching: { outs: 3, er: 0 }
  },
  {
    // Rostered, in the book, and never batted or pitched.
    id: 'gam_statsTablesSummer1',
    season: seasons.summer,
    team: teams.ravens,
    opponent: teams.owls,
    home: true,
    start: '2024-07-10T18:00:00Z'
  }
]

const strikeout: ScoringAction[] = [
  { type: 'pitch', call: 'S' },
  { type: 'pitch', call: 'S' },
  { type: 'pitch', call: 'S' },
  { type: 'gameFlow', kind: 'closePlay' }
]

/**
 * Eight and a half innings: a home run leads off the home side's 3rd, and
 * every other batter strikes out. The game is left in progress after the
 * visitors' 9th, so its replay opens following it, at the end of a line
 * score nine innings wide, rather than at the first pitch.
 */
export function nineInningActions(): ScoringAction[] {
  const half = (): ScoringAction[] => [...strikeout, ...strikeout, ...strikeout]
  const homeRun: ScoringAction[] = [
    { type: 'pitch', call: 'C' },
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 31.5,
      launchAngleDragged: true,
      location: { x: -40, z: -128 },
      homeRunKind: 'out-of-park'
    },
    { type: 'result', eventType: 'home_run' },
    { type: 'gameFlow', kind: 'closePlay' }
  ]
  const actions: ScoringAction[] = []
  for (let inning = 1; inning <= 9; inning++) {
    actions.push(...half())
    if (inning === 3) actions.push(...homeRun)
    if (inning < 9) actions.push(...half())
  }
  return actions
}

async function clear(db: Db): Promise<void> {
  const games = [...LINES.map(line => line.id), STATS_TABLES_SEED.nineInnings]
  await db.deleteFrom('events').where('gameId', 'in', games).execute()
  await db
    .deleteFrom('game_player_stats')
    .where('game_id', 'in', games)
    .execute()
  await db
    .deleteFrom('game_stats_state')
    .where('game_id', 'in', games)
    .execute()
  await db.deleteFrom('games').where('id', 'in', games).execute()
}

async function ensureReader(db: Db): Promise<UserId> {
  const existing = await findUserByEmail(db, STATS_TABLES_SEED.email)
  if (existing != null) {
    await db
      .updateTable('users')
      .set({ login_enabled: true, is_admin: true })
      .where('id', '=', existing.id)
      .execute()
    return existing.id
  }
  const userId = await insertUser(db, {
    display_name: 'Stats Reader',
    first_name: 'Stats',
    last_name: 'Reader',
    login_enabled: true,
    is_admin: true
  })
  await addEmail(db, userId, STATS_TABLES_SEED.email, {
    isPrimary: true,
    source: 'manual'
  })
  return userId
}

export async function seedStatsTables(
  db: Db,
  options: { clock?: () => Date; password?: string } = {}
): Promise<StatsTablesSeed> {
  const clock = options.clock ?? (() => new Date())
  await seedReplay(db, {
    // The replay seed's accounts, which a developer may have signed in to.
    password: options.password ?? randomBytes(9).toString('base64url'),
    clock
  })
  await clear(db)

  for (const [id, name, year, starts, ends] of [
    [seasons.spring, 'Spring 2026', 2026, '2026-03-01', '2026-06-30'],
    [seasons.fall, 'Fall 2025', 2025, '2025-09-01', '2025-11-30'],
    [seasons.summer, 'Summer 2024', 2024, '2024-06-01', '2024-08-31']
  ] as const)
    await db
      .insertInto('seasons')
      .values({ id, name, year, starts_on: starts, ends_on: ends })
      .onConflict(oc => oc.column('id').doNothing())
      .execute()
  for (const [id, name, season] of [
    [teams.hawksSpring, 'Hawks', seasons.spring],
    [teams.hawksFall, 'Hawks', seasons.fall],
    [teams.ravens, 'Ravens', seasons.fall],
    [teams.owls, 'Owls', seasons.fall]
  ] as const) {
    await db
      .insertInto('teams')
      .values({ id, name })
      .onConflict(oc => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: season, team_id: id })
      .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
      .execute()
  }

  const betts = HOME_PLAYERS.find(player => player.last === 'Betts')!
  const found = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select('users.id')
    .where('memberships.team_id', '=', REPLAY_TEAMS.home.id)
    .where('users.first_name', '=', betts.first)
    .where('users.last_name', '=', betts.last)
    .executeTakeFirstOrThrow()
  const playerId = found.id
  const gumboId = await ensureGumboId(db, playerId)

  // The nine-inning game, scored, and its lines worked out by the builder.
  await db
    .insertInto('games')
    .values({
      id: STATS_TABLES_SEED.nineInnings,
      home_team_id: REPLAY_TEAMS.home.id,
      away_team_id: REPLAY_TEAMS.away.id,
      season_id: REPLAY_SEED.seasonId,
      start_at: clock(),
      venue: 'Replay Field',
      status: 'scheduled'
    })
    .execute()
  // The replay seed's players, by the ids it gave them.
  const gumboIds = new Map<Player, number>()
  for (const [teamId, players] of [
    [REPLAY_TEAMS.away.id, AWAY_PLAYERS],
    [REPLAY_TEAMS.home.id, HOME_PLAYERS]
  ] as const)
    for (const player of players) {
      const row = await db
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select('users.id')
        .where('memberships.team_id', '=', teamId)
        .where('users.first_name', '=', player.first)
        .where('users.last_name', '=', player.last)
        .executeTakeFirstOrThrow()
      gumboIds.set(player, await ensureGumboId(db, row.id))
    }
  const nine = await scored(
    nineInningActions(),
    replaySetup(player => gumboIds.get(player)!)
  )
  await postGamePlays(
    db,
    STATS_TABLES_SEED.nineInnings,
    asPostEventsBody({
      plays: nine.plays,
      currentPlay: nine.currentPlay,
      mode: 'live',
      source: { system: 'teamstation' }
    })
  )
  await drain(db, clock)

  // His other teams' games, written straight in as the builder writes them.
  for (const line of LINES) {
    await db
      .insertInto('games')
      .values({
        id: line.id,
        home_team_id: line.home ? line.team : line.opponent,
        away_team_id: line.home ? line.opponent : line.team,
        season_id: line.season,
        start_at: new Date(line.start),
        status: 'final'
      })
      .execute()
    await db
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: line.id,
        gumbo_id: gumboId,
        team_id: line.team,
        pa: line.batting?.pa ?? 0,
        ab: line.batting?.ab ?? 0,
        h: line.batting?.h ?? 0,
        singles: line.batting?.h ?? 0,
        bb: line.batting?.bb ?? 0,
        rbi: line.batting?.rbi ?? 0,
        pitch_outs: line.pitching?.outs ?? 0,
        pitch_bf: line.pitching == null ? 0 : line.pitching.outs + 2,
        pitch_h: line.pitching == null ? 0 : 1,
        pitch_er: line.pitching?.er ?? 0
      })
      .execute()
  }

  const readerId = await ensureReader(db)
  await db.deleteFrom('scope_roles').where('user_id', '=', readerId).execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: readerId,
      scope_type: 'team',
      scope_id: REPLAY_TEAMS.home.id,
      role: 'coach'
    })
    .execute()
  return {
    playerId,
    readerId,
    teams,
    seasons,
    boxScoreGame: REPLAY_SEED.games.final,
    coachTeam: REPLAY_TEAMS.home.id,
    nineInnings: STATS_TABLES_SEED.nineInnings,
    token: await mintToken(db)
  }
}

/** A sign-in token for the reader, which voids their earlier unused one. */
export async function mintToken(db: Db): Promise<string> {
  return (await createEmailCode(db, STATS_TABLES_SEED.email, 'login')).token
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The stats tables seed does not run in production')
  }
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    console.log(
      JSON.stringify(
        process.argv.includes('--token')
          ? { token: await mintToken(db) }
          : await seedStatsTables(db, {
              password: process.env.TS_SEED_PASSWORD
            }),
        null,
        2
      )
    )
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('/statsTablesSeed.ts') ||
  entry.endsWith('/statsTablesSeed.js')
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
