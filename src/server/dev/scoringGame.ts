import type { Kysely, Transaction } from 'kysely'

import { makeId } from '../../common/ids'
import { addEmail, findUserByEmail } from '../auth/emails'
import { hashPassword } from '../auth/passwords'
import { type Database, makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import { insertUser } from '../users/insertUser'
import { mintUserId } from '../users/mintUserId'

/**
 * A fresh game to score while developing: a league, a season, two teams in it
 * with twelve rostered players each, and `--games <n>` scheduled games (one
 * by default) between them with no plays, no score and no scoring owner. It
 * also creates or updates a viewer — not an administrator — who is a member of
 * the home team, so the viewer can see the games and manages neither team.
 *
 *   npm run scoring-game -- viewer@example.com hunter2 --games 2
 *
 * Prints each game id and the user ids of the first nine players a side, in
 * batting order.
 *
 * Other development fixtures build on the same pieces: `userMinter`,
 * `createScoringGame` and `loginUser`.
 */
const POSITIONS = ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']

export type Mint = () => string

/** Draws independent account identities; insertion reserves them. */
export async function userMinter(_trx: Transaction<Database>): Promise<Mint> {
  return mintUserId
}

export interface ScoringGameFixture {
  leagueId: string
  seasonId: string
  homeTeamId: string
  awayTeamId: string
  games: string[]
  /** Each side's players' user ids, in roster order. */
  roster: Record<'home' | 'away', string[]>
}

/**
 * The league, season, teams, rosters and scheduled games. Each side's
 * players are named by `names` (a name is one word, the last name, or a
 * first and a last), or `Host 01` to `Host 12` and `Visitor 01` to
 * `Visitor 12` by default. Player i wears i + 1, and the first nine play P to
 * RF, so they bat one to nine and take the field in that order. The teams are
 * named `teams`, or `Hosts` and `Visitors` with a stamp that tells one run's
 * from another's.
 */
export async function createScoringGame(
  trx: Transaction<Database>,
  mint: Mint,
  options: {
    games?: number
    names?: Record<'home' | 'away', readonly string[]>
    teams?: Record<'home' | 'away', string>
  } = {}
): Promise<ScoringGameFixture> {
  const stamp = Date.now().toString(36)
  const leagueId = makeId('league')
  const seasonId = makeId('season')
  const homeTeamId = makeId('team')
  const awayTeamId = makeId('team')
  await trx
    .insertInto('leagues')
    .values({
      id: leagueId,
      name: `Scoring League ${stamp}`,
      short_name: 'SCR'
    })
    .execute()
  await trx
    .insertInto('seasons')
    .values({
      id: seasonId,
      league_id: leagueId,
      name: `Scoring Season ${stamp}`,
      year: 2026,
      term: 'Fall'
    })
    .execute()
  await trx
    .insertInto('teams')
    .values([
      { id: homeTeamId, name: options.teams?.home ?? `Hosts ${stamp}` },
      { id: awayTeamId, name: options.teams?.away ?? `Visitors ${stamp}` }
    ])
    .execute()
  await trx
    .insertInto('season_teams')
    .values([
      { season_id: seasonId, team_id: homeTeamId },
      { season_id: seasonId, team_id: awayTeamId }
    ])
    .execute()

  const roster: Record<'home' | 'away', string[]> = { home: [], away: [] }
  for (const [side, teamId] of [
    ['away', awayTeamId],
    ['home', homeTeamId]
  ] as const) {
    const names =
      options.names?.[side] ??
      // Padded so the roster, which lists players by name, lists them in
      // this order: the first nine bat one to nine and play P to RF.
      Array.from(
        { length: 12 },
        (_, i) =>
          `${side === 'home' ? 'Host' : 'Visitor'} ${String(i + 1).padStart(2, '0')}`
      )
    for (const [i, name] of names.entries()) {
      const words = name.split(' ')
      const userId = await insertUser(
        trx,
        {
          display_name: name,
          first_name: words.length > 1 ? words[0] : null,
          last_name: words.length > 1 ? words.slice(1).join(' ') : name,
          bats: i % 3 === 0 ? 'left' : 'right',
          throws: 'right'
        },
        mint
      )
      await trx
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member',
          is_player: true,
          jersey: String(i + 1),
          positions: i < POSITIONS.length ? [POSITIONS[i]] : []
        })
        .execute()
      roster[side].push(userId)
    }
  }

  const games: string[] = []
  for (let i = 0; i < (options.games ?? 1); i++) {
    const gameId = makeId('game')
    await trx
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        season_id: seasonId,
        start_at: new Date(Date.now() + i * 3600_000),
        venue: 'Scoring Field',
        status: 'scheduled'
      })
      .execute()
    games.push(gameId)
  }
  return { leagueId, seasonId, homeTeamId, awayTeamId, games, roster }
}

/**
 * A person who signs in with this e-mail and password, never an
 * administrator: created, or the one who has the e-mail updated, with
 * `displayName` (the e-mail's name by default) for a new one.
 */
export async function loginUser(
  trx: Transaction<Database>,
  mint: Mint,
  email: string,
  password: string,
  displayName?: string
): Promise<string> {
  const normalised = email.trim().toLowerCase()
  const passwordHash = await hashPassword(password)
  const existing = await findUserByEmail(trx, normalised)
  if (existing != null) {
    await trx
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
  const userId = await insertUser(
    trx,
    {
      display_name: displayName ?? normalised.split('@')[0],
      password_hash: passwordHash,
      login_enabled: true,
      is_admin: false
    },
    mint
  )
  await addEmail(trx, userId, normalised, {
    isPrimary: true,
    source: 'manual'
  })
  return userId
}

/**
 * Runs the command line against `db`, printing each line to `print`.
 * Refuses to run in production, and throws the usage for arguments it does
 * not understand.
 */
export async function runScoringGame(
  db: Kysely<Database>,
  args: string[],
  print: (line: string) => void
): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The scoring-game script does not run in production')
  }
  const gamesAt = args.indexOf('--games')
  const count = gamesAt < 0 ? 1 : Number(args[gamesAt + 1])
  const [email, password] = args.filter(
    (arg, i) => arg !== '--games' && (gamesAt < 0 || i !== gamesAt + 1)
  )
  if (
    email == null ||
    password == null ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    throw new Error(
      'Usage: npm run scoring-game -- <viewerEmail> <viewerPassword> [--games <n>]'
    )
  }

  const out = await db.transaction().execute(async trx => {
    const mint = await userMinter(trx)
    const { games, roster, homeTeamId } = await createScoringGame(trx, mint, {
      games: count
    })
    const viewerId = await loginUser(trx, mint, email, password)
    await trx
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: viewerId,
        team_id: homeTeamId,
        role: 'member'
      })
      .execute()
    return { games, roster, viewerId }
  })
  for (const game of out.games) print(`GAME_ID=${game}`)
  print(`AWAY=${out.roster.away.slice(0, 9).join(',')}`)
  print(`HOME=${out.roster.home.slice(0, 9).join(',')}`)
  print(`VIEWER=${out.viewerId}`)
}

/* c8 ignore start */
async function main(): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    await runScoringGame(db, process.argv.slice(2), line => {
      console.log(line)
    })
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/scoringGame.ts') || entry.endsWith('/scoringGame.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
/* c8 ignore stop */
