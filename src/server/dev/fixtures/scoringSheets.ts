import type { Transaction } from 'kysely'

import { makeId } from '../../../common/ids'
import type { StoredDefaultLineup } from '../../../common/scoring/lineupHistory'
import { POSITIONS } from '../../../common/scoring/state'
import type { Database } from '../../db/database'
import { ensureGumboId } from '../../users/insertUser'
import { createScoringGame, userMinter } from '../scoringGame'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** A player as the world rosters him: first and last name, and his jersey. */
type Rostered = readonly [first: string, last: string, jersey: string | null]

/**
 * The scoring sheets' ten a side (Owls away, Hawks home), each wearing his
 * place in the list: the names the sheets' scenarios read on screen.
 */
export const SHEET_PLAYERS: readonly Rostered[] = [
  ['Mookie', 'Betts', '1'],
  ['Mike', 'Trout', '2'],
  ['Shohei', 'Ohtani', '3'],
  ['Aaron', 'Judge', '4'],
  ['Bryce', 'Harper', '5'],
  ['Freddie', 'Freeman', '6'],
  ['Francisco', 'Lindor', '7'],
  ['Juan', 'Soto', '8'],
  ['Bobby', 'Witt', '9'],
  ['Julio', 'Rodriguez', '10']
]

/**
 * The roster editor's twelve a side: jerseys out of order, two without one,
 * as a real roster has them.
 */
export const ROSTER_PLAYERS: readonly Rostered[] = [
  ['Mookie', 'Betts', '1'],
  ['Mike', 'Trout', '2'],
  ['Shohei', 'Ohtani', '3'],
  ['Aaron', 'Judge', '4'],
  ['Bryce', 'Harper', '5'],
  ['Freddie', 'Freeman', '6'],
  ['Francisco', 'Lindor', '7'],
  ['Juan', 'Soto', '12'],
  ['Bobby', 'Witt', '99'],
  ['Julio', 'Rodriguez', '100'],
  ['Adam', 'Duvall', null],
  ['Zack', 'Wheeler', null]
]

const SCORER = { first: 'Alex', last: 'Cora' }

interface Group {
  games: string[]
  teams: Record<'away' | 'home', string>
  /** Each side's players' user ids and scoring ids, in roster order. */
  users: Record<'away' | 'home', string[]>
  gumbos: Record<'away' | 'home', number[]>
}

/**
 * Two teams, Owls and Hawks, with `players` a side, and `games` scheduled
 * games between them. Everyone bats and throws right and plays
 * `POSITIONS[i % 9]`; each side's default lineup has its first nine playing
 * P to RF, except that the home side's has no pitcher when `noHomePitcher`.
 * Its batting order is those nine, or with `everyoneBats` the whole roster in
 * roster order, as a team that bats everyone keeps it.
 */
async function makeGroup(
  trx: Transaction<Database>,
  players: readonly Rostered[],
  games: number,
  noHomePitcher: boolean,
  everyoneBats = false
): Promise<Group> {
  const names = players.map(([first, last]) => `${first} ${last}`)
  const made = await createScoringGame(trx, await userMinter(trx), {
    games,
    names: { away: names, home: names },
    teams: { away: 'Owls', home: 'Hawks' }
  })
  const teams = { away: made.awayTeamId, home: made.homeTeamId }
  const gumbos: Group['gumbos'] = { away: [], home: [] }
  for (const side of ['away', 'home'] as const) {
    for (const [i, userId] of made.roster[side].entries()) {
      await trx
        .updateTable('users')
        .set({ bats: 'right', throws: 'right' })
        .where('id', '=', userId as never)
        .execute()
      await trx
        .updateTable('memberships')
        .set({
          jersey: players[i][2],
          positions: [POSITIONS[i % POSITIONS.length]]
        })
        .where('user_id', '=', userId as never)
        .where('team_id', '=', teams[side])
        .execute()
      gumbos[side].push(await ensureGumboId(trx, userId))
    }
    const person = (i: number): { gumboId: number; jersey: string } => ({
      gumboId: gumbos[side][i],
      jersey: players[i][2] ?? ''
    })
    const value: StoredDefaultLineup = {
      lineup: {
        batters: (everyoneBats ? players : POSITIONS).map((_, i) => person(i)),
        defense: Object.fromEntries(
          POSITIONS.map((position, i) => [
            position,
            noHomePitcher && side === 'home' && position === 'P'
              ? null
              : person(i)
          ])
        ) as NonNullable<StoredDefaultLineup['lineup']>['defense']
      },
      fromGameId: null,
      setAt: new Date().toISOString()
    }
    await trx
      .updateTable('teams')
      .set({ default_lineup: value })
      .where('id', '=', teams[side])
      .execute()
  }
  return { games: made.games, teams, users: made.roster, gumbos }
}

/** The scorer keeps score for both teams: the role alone, on neither roster. */
async function keepScore(
  trx: Transaction<Database>,
  scorer: FixtureAccount,
  group: Group
): Promise<void> {
  await trx
    .insertInto('scope_roles')
    .values(
      [group.teams.away, group.teams.home].map(teamId => ({
        id: makeId('scopeRole'),
        user_id: scorer.userId as never,
        scope_type: 'team' as const,
        scope_id: teamId,
        role: 'scorekeeper' as const
      }))
    )
    .execute()
}

/** A group's ids by name: its teams, games and each side's players. */
function idsOf(prefix: string, group: Group): Record<string, string> {
  return {
    [`${prefix}AwayTeam`]: group.teams.away,
    [`${prefix}HomeTeam`]: group.teams.home,
    [`${prefix}Games`]: group.games.join(','),
    [`${prefix}AwayUsers`]: group.users.away.join(','),
    [`${prefix}HomeUsers`]: group.users.home.join(','),
    [`${prefix}AwayGumbos`]: group.gumbos.away.join(','),
    [`${prefix}HomeGumbos`]: group.gumbos.home.join(',')
  }
}

/**
 * What the scoring screen's sheets are driven on (Settings, Set Team
 * Rosters, Overrides, the tiebreaker, End Game): a scorekeeper of both
 * teams, `scorer`, and two sets of Owls at Hawks, ten a side named as
 * `SHEET_PLAYERS` names them. In `ready` (six games) both default lineups
 * are whole, so a game opens on its first pitch; in `noPitcher` (three
 * games) the home lineup has no pitcher, so a game opens asking for one. A
 * scenario opens a game no other has scored.
 */
export async function runScoringSheets(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'scoring-sheets'
  const scorer = await createAccount(context, world, 'scorer', SCORER)
  const ids = await context.db.transaction().execute(async trx => {
    const ready = await makeGroup(trx, SHEET_PLAYERS, 6, false)
    const noPitcher = await makeGroup(trx, SHEET_PLAYERS, 3, true)
    await keepScore(trx, scorer, ready)
    await keepScore(trx, scorer, noPitcher)
    return { ...idsOf('ready', ready), ...idsOf('noPitcher', noPitcher) }
  })
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}

/**
 * What the scorer's roster editor and the lineup's QR code are driven on: a
 * scorekeeper of both teams, `scorer`, and one game of Owls at Hawks, two
 * hours from now (so Schedule lists it as upcoming), with the twelve a side
 * `ROSTER_PLAYERS` names, every one of them in each side's batting order;
 * and `spareTeam`, on no season and with nobody on
 * it, where a scenario can set a roster aside to show an empty one.
 */
export async function runRosterEdit(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'roster-edit'
  const scorer = await createAccount(context, world, 'scorer', SCORER)
  const ids = await context.db.transaction().execute(async trx => {
    const group = await makeGroup(trx, ROSTER_PLAYERS, 1, false, true)
    await keepScore(trx, scorer, group)
    await trx
      .updateTable('games')
      .set({ start_at: new Date(Date.now() + 2 * 3_600_000) })
      .where('id', '=', group.games[0])
      .execute()
    const spareTeam = makeId('team')
    await trx
      .insertInto('teams')
      .values({ id: spareTeam, name: 'Owls set aside' })
      .execute()
    return { game: group.games[0], spareTeam, ...idsOf('roster', group) }
  })
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}
