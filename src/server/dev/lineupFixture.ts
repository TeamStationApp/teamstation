import type { Kysely, Transaction } from 'kysely'

import { makeId } from '../../common/ids'
import type { Role } from '../../common/roles'
import type { DefaultLineup, Lineup } from '../../common/scoring/lineupHistory'
import { POSITIONS } from '../../common/scoring/state'
import { type Database, makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import {
  createScoringGame,
  loginUser,
  type Mint,
  userMinter
} from './scoringGame'

/**
 * The game the lineup dictation and Coach Game end-to-end tests run against:
 * `scoring-game`'s league, season, two teams (Visitors and Hosts) and one
 * scheduled game, with thirteen players a side named for major leaguers. Each
 * team's default lineup is its first nine, batting one to nine and playing P
 * to RF; the other four, a Freeman among them on each side, start on the
 * bench. Five people sign in with `--password`:
 *
 * - a scorekeeper of both teams;
 * - the home team's head coach and its assistant;
 * - the away team's head coach;
 * - a member of the home team, who neither scores nor coaches.
 *
 *   npm run lineup-fixture -- --password <password>
 *
 * Prints the game, the teams, each person's e-mail and user id, and each
 * side's players in that order, as JSON. The password is never printed. Run
 * again, it makes a new game and gives the same five people their roles on
 * its teams.
 */
export const LINEUP_NAMES: Record<'home' | 'away', readonly string[]> = {
  away: [
    'Judge',
    'Altuve',
    'Bregman',
    'Alvarez',
    'Tucker',
    'Pena',
    'Diaz',
    'Maldonado',
    'Valdez',
    'Betts',
    'Springer',
    'Semien',
    'Freeman'
  ],
  home: [
    'Ohtani',
    'Lindor',
    'Alonso',
    'Nimmo',
    'Marte',
    'McNeil',
    'Escobar',
    'Canha',
    'Senga',
    'Soto',
    'Harper',
    'Turner',
    'Freeman'
  ]
}

type Person = 'scorekeeper' | 'headCoach' | 'assistant' | 'awayCoach' | 'member'
const PEOPLE: Record<
  Person,
  { email: string; name: string; teams: Array<'home' | 'away'>; role?: Role }
> = {
  scorekeeper: {
    email: 'lineup.scorekeeper@example.test',
    name: 'Cora',
    teams: ['away', 'home'],
    role: 'scorekeeper'
  },
  headCoach: {
    email: 'lineup.coach@example.test',
    name: 'Boone',
    teams: ['home'],
    role: 'coach'
  },
  assistant: {
    email: 'lineup.assistant@example.test',
    name: 'Mattingly',
    teams: ['home'],
    role: 'assistant'
  },
  awayCoach: {
    email: 'lineup.awaycoach@example.test',
    name: 'Roberts',
    teams: ['away'],
    role: 'coach'
  },
  member: {
    email: 'lineup.member@example.test',
    name: 'Jeter',
    teams: ['home']
  }
}

export interface LineupFixture {
  gameId: string
  seasonId: string
  teams: Record<'home' | 'away', string>
  users: Record<Person, { email: string; userId: number }>
  players: Record<
    'home' | 'away',
    Array<{ userId: number; name: string; jersey: string }>
  >
}

/** Makes the fixture in `trx`. */
export async function createLineupFixture(
  trx: Transaction<Database>,
  password: string,
  mint?: Mint
): Promise<LineupFixture> {
  const minter = mint ?? (await userMinter(trx))
  // Every run's teams have the same names, so its screens look the same.
  const game = await createScoringGame(trx, minter, {
    names: LINEUP_NAMES,
    teams: { away: 'Visitors', home: 'Hosts' }
  })
  const teams = { home: game.homeTeamId, away: game.awayTeamId }
  for (const side of ['away', 'home'] as const) {
    const people = game.roster[side]
      .slice(0, POSITIONS.length)
      .map((userId, i) => ({
        gumboId: userId,
        name: LINEUP_NAMES[side][i],
        jersey: String(i + 1)
      }))
    const value: DefaultLineup = {
      lineup: {
        batters: people,
        defense: Object.fromEntries(
          POSITIONS.map((position, i) => [position, people[i]])
        ) as Lineup['defense']
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
  const person = async (
    who: (typeof PEOPLE)[Person]
  ): Promise<{ email: string; userId: number }> => {
    const userId = await loginUser(trx, minter, who.email, password, who.name)
    for (const side of who.teams) {
      await trx
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teams[side],
          role: 'member'
        })
        .execute()
      if (who.role != null)
        await trx
          .insertInto('scope_roles')
          .values({
            id: makeId('scopeRole'),
            user_id: userId,
            scope_type: 'team',
            scope_id: teams[side],
            role: who.role
          })
          .execute()
    }
    return { email: who.email, userId }
  }
  const users: LineupFixture['users'] = {
    scorekeeper: await person(PEOPLE.scorekeeper),
    headCoach: await person(PEOPLE.headCoach),
    assistant: await person(PEOPLE.assistant),
    awayCoach: await person(PEOPLE.awayCoach),
    member: await person(PEOPLE.member)
  }
  const sidePlayers = (
    side: 'home' | 'away'
  ): LineupFixture['players']['home'] =>
    game.roster[side].map((userId, i) => ({
      userId,
      name: LINEUP_NAMES[side][i],
      jersey: String(i + 1)
    }))
  const players: LineupFixture['players'] = {
    away: sidePlayers('away'),
    home: sidePlayers('home')
  }
  return {
    gameId: game.games[0],
    seasonId: game.seasonId,
    teams,
    users,
    players
  }
}

/**
 * Runs the command line against `db`, printing the fixture to `print`.
 * Refuses to run in production, and throws the usage for any other
 * arguments than `--password <password>`.
 */
export async function runLineupFixture(
  db: Kysely<Database>,
  args: string[],
  print: (text: string) => void
): Promise<LineupFixture> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('The lineup-fixture script does not run in production')
  const at = args.indexOf('--password')
  const password = at < 0 ? undefined : args[at + 1]
  if (password == null || password === '' || args.length !== 2)
    throw new Error('Usage: npm run lineup-fixture -- --password <password>')
  const fixture = await db
    .transaction()
    .execute(async trx => await createLineupFixture(trx, password))
  print(JSON.stringify(fixture, null, 2))
  return fixture
}

/* c8 ignore start */
async function main(): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    await runLineupFixture(db, process.argv.slice(2), text => {
      console.log(text)
    })
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('/lineupFixture.ts') ||
  entry.endsWith('/lineupFixture.js')
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
/* c8 ignore stop */
