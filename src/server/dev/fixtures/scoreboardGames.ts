import { makeId } from '../../../common/ids'
import { insertUser } from '../../users/insertUser'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/**
 * The games the scoreboard scenarios run against, as the old
 * `seedScoreboardGames` seeder made them:
 *
 * - `runner` owns the team Scoreboard E2E and keeps score for it, so its
 *   games' boards are theirs to publish to and override; `other` is a plain
 *   `member` of it, who can see its games but runs nothing;
 * - Scoreboard E2E and its opponent Scoreboard E2E Visitors each have twelve
 *   rostered players (`Pioneer 01` … and `Visitor 01` …, the first nine
 *   playing P to RF), so their games can be scored;
 * - nine games between them, from the moment the world is seeded: now − 4 h
 *   (`minus4h`), − 10 m (`minus10m`), + 1 h to + 6 h (`plus1h` … `plus6h`),
 *   and one already cancelled at + 30 m (`cancelled`).
 *
 * The runner is this world's alone, so the games they run are exactly these.
 */

export const SCOREBOARD_TEAM = 'Scoreboard E2E'
export const SCOREBOARD_VISITORS = 'Scoreboard E2E Visitors'

const PEOPLE = {
  runner: { first: 'Corwin', last: 'Ashdale' },
  other: { first: 'Yselda', last: 'Brannock' }
}

const POSITIONS = ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']
const HOUR = 3_600_000
const MINUTE = 60_000

/** Each game's name in the manifest's `ids`, and its offset from now. */
export const SCOREBOARD_SLOTS = [
  { name: 'minus4h', offset: -4 * HOUR },
  { name: 'minus10m', offset: -10 * MINUTE },
  ...[1, 2, 3, 4, 5, 6].map(hours => ({
    name: `plus${hours}h`,
    offset: hours * HOUR
  })),
  { name: 'cancelled', offset: 30 * MINUTE }
]

export async function runScoreboardGames(
  context: WorldContext,
  now = Date.now()
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'scoreboard-games'
  const runner = await createAccount(context, world, 'runner', PEOPLE.runner)
  const other = await createAccount(context, world, 'other', PEOPLE.other)
  const ids: Record<string, string> = {}
  await db.transaction().execute(async trx => {
    const team = async (name: string, label: string): Promise<string> => {
      const teamId = makeId('team')
      await trx.insertInto('teams').values({ id: teamId, name }).execute()
      for (let i = 0; i < 12; i++) {
        // Padded so the roster, which lists players by name, keeps this order.
        const number = String(i + 1).padStart(2, '0')
        const userId = await insertUser(trx, {
          display_name: `${label} ${number}`,
          first_name: label,
          last_name: number,
          bats: 'right',
          throws: 'right'
        })
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
      }
      return teamId
    }
    const home = await team(SCOREBOARD_TEAM, 'Pioneer')
    const away = await team(SCOREBOARD_VISITORS, 'Visitor')
    for (const [who, role] of [
      [runner, 'owner'],
      [other, 'member']
    ] as const) {
      await trx
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: who.userId as never,
          team_id: home,
          role
        })
        .execute()
    }
    // Score is offered to a scorekeeper of one of the game's teams.
    await trx
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: runner.userId as never,
        scope_type: 'team',
        scope_id: home,
        role: 'scorekeeper'
      })
      .execute()
    for (const slot of SCOREBOARD_SLOTS) {
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
      ids[slot.name] = id
    }
    ids.homeTeam = home
    ids.awayTeam = away
    ids.homeTeamName = SCOREBOARD_TEAM
    ids.awayTeamName = SCOREBOARD_VISITORS
  })
  return { world, nonce, accounts: { runner, other }, ids }
}
