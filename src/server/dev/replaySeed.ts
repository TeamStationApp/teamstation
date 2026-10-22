import { randomBytes } from 'node:crypto'

import type { Kysely } from 'kysely'

import { asPostEventsBody, type GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { StoredGame } from '../../common/scoring/session'
import type { UserId } from '../../common/userId'
import {
  asImported,
  AWAY_PLAYERS,
  finalGame,
  HOME_PLAYERS,
  importedThenScoredGame,
  inProgressGame,
  type Player,
  rallyGame,
  REPLAY_TEAMS,
  replaySetup
} from '../../test/replayGameFixture'
import { addEmail, findUserByEmail } from '../auth/emails'
import { hashPassword } from '../auth/passwords'
import { type Database, makeDatabase } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { serverConfig } from '../serverConfig'
import { drain } from '../statsBuilder/builder'
import { ensureGumboId, insertUser } from '../users/insertUser'

/**
 * The games the replay's end-to-end scenarios run against, in a development
 * database: a made-up league with one season and two teams, the replay
 * fixture's game stored four ways, a short rally game whose grand slam
 * scores three runners, and five accounts to sign in with.
 *
 *   node -r sucrase/register src/server/dev/replaySeed.ts [--password <pw>]
 *
 * Everything it owns has a fixed id and is rebuilt on every run. It refuses
 * to run in production.
 */

export const REPLAY_SEED = {
  leagueId: 'lea_replaySeedLeague',
  seasonId: 'sea_replaySeedSeason',
  games: {
    final: 'gam_replaySeedFinal',
    inProgress: 'gam_replaySeedLive',
    importedThenScored: 'gam_replaySeedMixed',
    imported: 'gam_replaySeedImported',
    rally: 'gam_replaySeedRally'
  },
  emails: {
    team: 'replay-team@example.test',
    season: 'replay-season@example.test',
    league: 'replay-league@example.test',
    scorer: 'replay-scorer@example.test',
    outsider: 'replay-outsider@example.test'
  }
} as const

export interface ReplaySeed {
  games: typeof REPLAY_SEED.games
  accounts: Record<keyof typeof REPLAY_SEED.emails, UserId>
  password: string
}

type Db = Kysely<Database>

const GAME_IDS = Object.values(REPLAY_SEED.games)
const TEAM_IDS = [REPLAY_TEAMS.away.id, REPLAY_TEAMS.home.id]

async function clear(db: Db): Promise<void> {
  await db.deleteFrom('events').where('gameId', 'in', GAME_IDS).execute()
  await db
    .deleteFrom('game_player_stats')
    .where('game_id', 'in', GAME_IDS)
    .execute()
  await db
    .deleteFrom('game_stats_state')
    .where('game_id', 'in', GAME_IDS)
    .execute()
  await db.deleteFrom('games').where('id', 'in', GAME_IDS).execute()
}

async function ensureAccount(
  db: Db,
  email: string,
  passwordHash: string
): Promise<UserId> {
  const existing = await findUserByEmail(db, email)
  if (existing != null) {
    await db
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        login_enabled: true,
        is_admin: false
      })
      .where('id', '=', existing.id)
      .execute()
    return existing.id
  }
  const userId = await insertUser(db, {
    display_name: email.split('@')[0],
    password_hash: passwordHash,
    login_enabled: true,
    is_admin: false
  })
  await addEmail(db, userId, email, {
    isPrimary: true,
    source: 'manual'
  })
  return userId
}

/**
 * A player of the team, found by name or made, with a rostered membership.
 * Their scoring id is what the game names them by.
 */
async function ensurePlayer(
  db: Db,
  teamId: string,
  player: Player
): Promise<number> {
  const found = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select('users.id')
    .where('memberships.team_id', '=', teamId)
    .where('users.first_name', '=', player.first)
    .where('users.last_name', '=', player.last)
    .executeTakeFirst()
  if (found != null) return await ensureGumboId(db, found.id)
  const userId = await insertUser(db, {
    display_name: `${player.first} ${player.last}`,
    first_name: player.first,
    last_name: player.last,
    bats: 'right',
    throws: 'right'
  })
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: userId,
      team_id: teamId,
      role: 'member',
      is_player: true,
      positions: player.position == null ? [] : [player.position]
    })
    .execute()
  return await ensureGumboId(db, userId)
}

async function ensureTeamMember(
  db: Db,
  userId: UserId,
  teamId: string
): Promise<void> {
  const found = await db
    .selectFrom('memberships')
    .select('id')
    .where('user_id', '=', userId)
    .where('team_id', '=', teamId)
    .executeTakeFirst()
  if (found == null)
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role: 'member'
      })
      .execute()
}

async function post(
  db: Db,
  gameId: string,
  plays: GumboPlay[],
  currentPlay: StoredGame['currentPlay'],
  system: 'teamstation' | 'importer'
): Promise<void> {
  await postGamePlays(
    db,
    gameId,
    asPostEventsBody({
      plays,
      ...(system === 'teamstation' ? { currentPlay, mode: 'live' } : {}),
      source: { system }
    })
  )
}

export async function seedReplay(
  db: Db,
  options: { password: string; clock?: () => Date }
): Promise<ReplaySeed> {
  const clock = options.clock ?? (() => new Date())
  await clear(db)

  await db
    .insertInto('leagues')
    .values({ id: REPLAY_SEED.leagueId, name: 'Replay League' })
    .onConflict(oc => oc.column('id').doNothing())
    .execute()
  await db
    .insertInto('seasons')
    .values({
      id: REPLAY_SEED.seasonId,
      league_id: REPLAY_SEED.leagueId,
      name: 'Replay Season',
      year: 2026,
      starts_on: '2026-01-01',
      ends_on: '2026-12-31'
    })
    .onConflict(oc => oc.column('id').doNothing())
    .execute()
  for (const team of [REPLAY_TEAMS.away, REPLAY_TEAMS.home]) {
    await db
      .insertInto('teams')
      .values({ id: team.id, name: team.name })
      .onConflict(oc => oc.column('id').doNothing())
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: REPLAY_SEED.seasonId, team_id: team.id })
      .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
      .execute()
  }

  const gumboIds = new Map<Player, number>()
  for (const [teamId, players] of [
    [REPLAY_TEAMS.away.id, AWAY_PLAYERS],
    [REPLAY_TEAMS.home.id, HOME_PLAYERS]
  ] as const)
    for (const player of players)
      gumboIds.set(player, await ensurePlayer(db, teamId, player))

  const passwordHash = await hashPassword(options.password)
  const account = async (email: string): Promise<UserId> =>
    await ensureAccount(db, email, passwordHash)
  const accounts: ReplaySeed['accounts'] = {
    team: await account(REPLAY_SEED.emails.team),
    season: await account(REPLAY_SEED.emails.season),
    league: await account(REPLAY_SEED.emails.league),
    scorer: await account(REPLAY_SEED.emails.scorer),
    outsider: await account(REPLAY_SEED.emails.outsider)
  }
  const accountIds = Object.values(accounts)
  await db
    .deleteFrom('scope_roles')
    .where('user_id', 'in', accountIds)
    .execute()
  await db
    .deleteFrom('season_members')
    .where('user_id', 'in', accountIds)
    .execute()
  await db
    .deleteFrom('league_members')
    .where('user_id', 'in', accountIds)
    .execute()
  await db
    .deleteFrom('memberships')
    .where('user_id', 'in', accountIds)
    .where('team_id', 'in', TEAM_IDS)
    .execute()
  await ensureTeamMember(db, accounts.team, REPLAY_TEAMS.home.id)
  await ensureTeamMember(db, accounts.scorer, REPLAY_TEAMS.home.id)
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: accounts.scorer,
      scope_type: 'team',
      scope_id: REPLAY_TEAMS.home.id,
      role: 'scorekeeper'
    })
    .execute()
  await db
    .insertInto('season_members')
    .values({
      id: makeId('seasonMember'),
      user_id: accounts.season,
      season_id: REPLAY_SEED.seasonId
    })
    .execute()
  await db
    .insertInto('league_members')
    .values({
      id: makeId('leagueMember'),
      user_id: accounts.league,
      league_id: REPLAY_SEED.leagueId
    })
    .execute()

  for (const id of GAME_IDS)
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: REPLAY_TEAMS.home.id,
        away_team_id: REPLAY_TEAMS.away.id,
        season_id: REPLAY_SEED.seasonId,
        start_at: clock(),
        venue: 'Replay Field',
        status: 'scheduled'
      })
      .execute()

  const setup = replaySetup(player => gumboIds.get(player)!)
  const final = await finalGame(setup)
  await post(
    db,
    REPLAY_SEED.games.final,
    final.plays,
    final.currentPlay,
    'teamstation'
  )
  const live = await inProgressGame(setup)
  await post(
    db,
    REPLAY_SEED.games.inProgress,
    live.plays,
    live.currentPlay,
    'teamstation'
  )
  const mixed = await importedThenScoredGame(setup)
  const imported = mixed.plays.filter(play => !('teamStation' in play))
  await post(
    db,
    REPLAY_SEED.games.importedThenScored,
    imported,
    null,
    'importer'
  )
  // Plays that carry both scores finish a game posted from outside; the
  // scorer picked it up while it was still being played.
  await db
    .updateTable('games')
    .set({ status: 'inProgress' })
    .where('id', '=', REPLAY_SEED.games.importedThenScored)
    .execute()
  await post(
    db,
    REPLAY_SEED.games.importedThenScored,
    mixed.plays.filter(play => 'teamStation' in play),
    mixed.currentPlay,
    'teamstation'
  )
  const rally = await rallyGame(setup)
  await post(
    db,
    REPLAY_SEED.games.rally,
    rally.plays,
    rally.currentPlay,
    'teamstation'
  )
  await post(
    db,
    REPLAY_SEED.games.imported,
    final.plays.map(asImported),
    null,
    'importer'
  )
  await drain(db, clock)
  return { games: REPLAY_SEED.games, accounts, password: options.password }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The replay seed does not run in production')
  }
  const flag = process.argv.indexOf('--password')
  const password =
    flag >= 0 ? process.argv[flag + 1] : randomBytes(9).toString('base64url')
  if (password == null || password === '')
    throw new Error('Usage: replaySeed.ts [--password <pw>]')
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const seeded = await seedReplay(db, { password })
    console.log(
      JSON.stringify(
        { ...seeded, emails: REPLAY_SEED.emails, password },
        null,
        2
      )
    )
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/replaySeed.ts') || entry.endsWith('/replaySeed.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
