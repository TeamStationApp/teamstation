import type { Kysely } from 'kysely'

import { makeId } from '../common/ids'
import { mintUserId } from '../common/mintUserId'
import { addEmail, findUserByEmail } from '../server/auth/emails'
import { type Database, makeDatabase } from '../server/db/database'

/**
 * The games one group of scoreboard end-to-end scenarios runs against.
 *
 *   node -r sucrase/register src/test/seedScoreboardGames.e2e.ts <databaseUrl>
 *
 * Ensures two non-admin accounts: `scoreboard-e2e@gamestation.local`, who
 * owns the team Scoreboard E2E, and `scoreboard-e2e-other@gamestation.local`,
 * a plain `member` of it, who can see its games but runs nothing; and the
 * opponent Scoreboard E2E Visitors. Both teams
 * have twelve rostered players, so their games can be scored. It cancels
 * every game Scoreboard E2E already has, then inserts nine with fresh ids and
 * prints them one per line in this order: now − 4 h, − 10 m, + 1 h to + 6 h,
 * and one already cancelled at + 30 m.
 *
 * A development database only: it refuses NODE_ENV=production.
 */

export const RUNNER_EMAIL = 'scoreboard-e2e@gamestation.local'
export const OTHER_EMAIL = 'scoreboard-e2e-other@gamestation.local'
export const TEAM_NAME = 'Scoreboard E2E'
export const VISITORS_NAME = 'Scoreboard E2E Visitors'

const POSITIONS = ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']
const HOUR = 3_600_000
const MINUTE = 60_000

/** The offsets from now, in the order the ids are printed. */
export const SEEDED = [
  { name: '-4h', offset: -4 * HOUR },
  { name: '-10m', offset: -10 * MINUTE },
  ...[1, 2, 3, 4, 5, 6].map(hours => ({
    name: `+${hours}h`,
    offset: hours * HOUR
  })),
  { name: 'cancelled', offset: 30 * MINUTE }
]

type Trx = Kysely<Database>

async function ensureUser(
  trx: Trx,
  email: string,
  mint: () => { userId: number; legacyId: string }
): Promise<number> {
  const existing = await findUserByEmail(trx, email)
  if (existing != null) {
    await trx
      .updateTable('users')
      .set({ login_enabled: true, is_admin: false })
      .where('id', '=', existing.id)
      .execute()
    return existing.id
  }
  const minted = mint()
  await trx
    .insertInto('users')
    .values({
      id: minted.userId,
      legacyId: minted.legacyId,
      display_name: email.split('@')[0],
      login_enabled: true,
      is_admin: false
    })
    .execute()
  await addEmail(trx, minted.userId, email, {
    isPrimary: true,
    source: 'manual'
  })
  return minted.userId
}

/** The team by name, made with twelve rostered players when it is new. */
async function ensureTeam(
  trx: Trx,
  name: string,
  label: string,
  mint: () => { userId: number; legacyId: string }
): Promise<string> {
  const found = await trx
    .selectFrom('teams')
    .select('id')
    .where('name', '=', name)
    .executeTakeFirst()
  if (found != null) return found.id
  const teamId = makeId('team')
  await trx.insertInto('teams').values({ id: teamId, name }).execute()
  for (let i = 0; i < 12; i++) {
    const minted = mint()
    // Padded so the roster, which lists players by name, keeps this order.
    const number = String(i + 1).padStart(2, '0')
    await trx
      .insertInto('users')
      .values({
        id: minted.userId,
        legacyId: minted.legacyId,
        display_name: `${label} ${number}`,
        first_name: label,
        last_name: number,
        bats: 'right',
        throws: 'right'
      })
      .execute()
    await trx
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: minted.userId,
        team_id: teamId,
        role: 'member',
        is_player: true,
        jersey: String(i + 1),
        positions: i < POSITIONS.length ? [POSITIONS[i]] : []
      })
      .execute()
  }
  return teamId
}

/** The user's one membership of the team, made or changed to `role`. */
async function ensureRole(
  trx: Trx,
  userId: number,
  teamId: string,
  role: 'owner' | 'member'
): Promise<void> {
  const found = await trx
    .selectFrom('memberships')
    .select(['id', 'role'])
    .where('user_id', '=', userId)
    .where('team_id', '=', teamId)
    .executeTakeFirst()
  if (found == null) {
    await trx
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role
      })
      .execute()
  } else if (found.role !== role) {
    await trx
      .updateTable('memberships')
      .set({ role })
      .where('id', '=', found.id)
      .execute()
  }
}

export async function seedScoreboardGames(
  db: Kysely<Database>,
  now = Date.now()
): Promise<string[]> {
  return await db.transaction().execute(async trx => {
    const held = new Set(
      (await trx.selectFrom('users').select('id').execute()).map(row => row.id)
    )
    const mint = (): { userId: number; legacyId: string } => {
      const minted = mintUserId(id => held.has(id))
      held.add(minted.userId)
      return minted
    }
    const runner = await ensureUser(trx, RUNNER_EMAIL, mint)
    const other = await ensureUser(trx, OTHER_EMAIL, mint)
    const home = await ensureTeam(trx, TEAM_NAME, 'Pioneer', mint)
    const away = await ensureTeam(trx, VISITORS_NAME, 'Visitor', mint)
    await ensureRole(trx, runner, home, 'owner')
    await ensureRole(trx, other, home, 'member')
    await trx
      .updateTable('games')
      .set({ status: 'cancelled', updated_at: new Date(now) })
      .where(eb =>
        eb.or([eb('home_team_id', '=', home), eb('away_team_id', '=', home)])
      )
      .execute()
    const ids: string[] = []
    for (const slot of SEEDED) {
      const id = makeId('game')
      await trx
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date(now + slot.offset),
          venue: 'Scoreboard Field',
          status: slot.name === 'cancelled' ? 'cancelled' : 'scheduled'
        })
        .execute()
      ids.push(id)
    }
    return ids
  })
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The scoreboard seeder does not run in production')
  }
  const databaseUrl = process.argv[2]
  if (databaseUrl == null) {
    throw new Error(
      'Usage: node -r sucrase/register src/test/seedScoreboardGames.e2e.ts <databaseUrl>'
    )
  }
  const db = makeDatabase(databaseUrl)
  try {
    for (const id of await seedScoreboardGames(db)) console.log(id)
  } finally {
    await db.destroy()
  }
}

if ((process.argv[1] ?? '').endsWith('/seedScoreboardGames.e2e.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
