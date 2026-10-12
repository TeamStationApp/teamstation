import { randomBytes } from 'node:crypto'

import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import type { Role } from '../../common/roles'
import { addEmail } from '../auth/emails'
import { hashPassword } from '../auth/passwords'
import { type Database, makeDatabase } from '../db/database'
import { setFollow } from '../groups/follows'
import { linkGuardian } from '../people/guardians'

/**
 * The chat fixture: QPLL, its Spring 2027 season, and Hawks, Eagles and Owls
 * in it, with one person in every role the chat scenarios name.
 *
 *   npm run chat-seed
 *
 * It refuses to run in production. Run it twice and nothing is doubled:
 * every row it makes is found again by an external id of system `chatSeed`
 * (people with an address by that address), and brought back to the fixture.
 * Every password is set again on each run and printed, from
 * `TS_CHAT_SEED_PASSWORD` when that is set (the same for everybody) and made
 * up per person otherwise.
 *
 * Who is who, by the key the scenarios use:
 *
 * - **QPLL and Spring 2027:** league admin L, season admin S, season
 *   scorekeeper K.
 * - **Site admin** Z.
 * - **Hawks:** admin Ha (an owner membership), coach Hc, scorekeeper Hk,
 *   songkeeper Hs; players P, R and T with accounts, and Q without one;
 *   invited parents A, B and C, and parent N; fan F, who follows Hawks;
 *   G1 and G2, P's guardians, on Hawks through those links.
 * - **Birth months**, from the day the seed runs: P is 15, R is 12, and T,
 *   born exactly 13 years before this month, is still 12 until the first of
 *   next month; Eagles player E is 16. Nobody else has one.
 * - **Eagles:** admin Ea, coach Ec, scorekeeper Ek, songkeeper Es; player E,
 *   who also follows Hawks; invited parents D and D2.
 * - **Owls:** a full team with nobody on it.
 * - **Games:** Hawks v Owls a week ago (final, 6–3, with a video), Hawks v
 *   Owls a week from now, and Eagles v Hawks eight days from now. Their
 *   dates move with the day the seed runs.
 *
 * A team role is a `member` membership plus the role on the team, as the
 * manage page makes one; the admins hold an `owner` membership instead.
 */

const SYSTEM = 'chatSeed'

export type TeamKey = 'hawks' | 'eagles' | 'owls'
export type GameKey = 'hawksOwlsFinal' | 'hawksOwlsNext' | 'eaglesHawksNext'

export interface SeedPerson {
  key: string
  firstName: string
  lastName: string
  /** Null for the player who has no way to sign in. */
  email: string | null
  isAdmin?: boolean
  /** A place on a team's roster. */
  team?: { key: TeamKey; role: 'owner' | 'member'; isPlayer: boolean }
  /** A role on the team above, or on the league or season. */
  roles?: Array<{ on: 'team' | 'season' | 'league'; role: Role }>
  follows?: TeamKey[]
  /** A guardian of this player (by key), linked on the player's team. */
  guardianOf?: string
  /** Born this many years and months before the month the seed runs. */
  born?: { years: number; months: number }
}

const at = (key: string): string => `${key.toLowerCase()}@chat.example.com`

/** Everybody the fixture holds, in the order they are printed. */
export const SEED_PEOPLE: SeedPerson[] = [
  {
    key: 'L',
    firstName: 'Lena',
    lastName: 'League',
    email: at('L'),
    roles: [{ on: 'league', role: 'admin' }]
  },
  {
    key: 'S',
    firstName: 'Sam',
    lastName: 'Season',
    email: at('S'),
    roles: [{ on: 'season', role: 'admin' }]
  },
  {
    key: 'K',
    firstName: 'Kim',
    lastName: 'Keeper',
    email: at('K'),
    roles: [{ on: 'season', role: 'scorekeeper' }]
  },
  {
    key: 'Z',
    firstName: 'Zoe',
    lastName: 'Admin',
    email: at('Z'),
    isAdmin: true
  },
  ...staff('hawks', [
    ['Ha', 'Harper', 'Hawkins', 'admin'],
    ['Hc', 'Hank', 'Coach', 'coach'],
    ['Hk', 'Holly', 'Scorer', 'scorekeeper'],
    ['Hs', 'Hugo', 'Songs', 'songkeeper']
  ]),
  { ...player('hawks', 'P', 'Pat', 'Player'), born: { years: 15, months: 1 } },
  {
    ...player('hawks', 'R', 'Riley', 'Rookie'),
    born: { years: 12, months: 1 }
  },
  { ...player('hawks', 'T', 'Trea', 'Turner'), born: { years: 13, months: 0 } },
  { ...player('hawks', 'Q', 'Quilvio', 'Veras'), email: null },
  parent('hawks', 'A', 'Alex', 'Ashby'),
  parent('hawks', 'B', 'Blair', 'Brooks'),
  parent('hawks', 'C', 'Casey', 'Cole'),
  parent('hawks', 'N', 'Nora', 'Nash'),
  guardian('P', 'G1', 'Gale', 'Guardian'),
  guardian('P', 'G2', 'Glen', 'Guardian'),
  {
    key: 'F',
    firstName: 'Frankie',
    lastName: 'Fan',
    email: at('F'),
    follows: ['hawks']
  },
  ...staff('eagles', [
    ['Ea', 'Erin', 'Eastman', 'admin'],
    ['Ec', 'Eddie', 'Coach', 'coach'],
    ['Ek', 'Ellis', 'Scorer', 'scorekeeper'],
    ['Es', 'Emery', 'Songs', 'songkeeper']
  ]),
  {
    ...player('eagles', 'E', 'Eli', 'Eagle'),
    follows: ['hawks'],
    born: { years: 16, months: 1 }
  },
  parent('eagles', 'D', 'Dana', 'Dunn'),
  parent('eagles', 'D2', 'Drew', 'Dalton')
]

function staff(
  team: TeamKey,
  people: Array<[string, string, string, Role]>
): SeedPerson[] {
  return people.map(([key, firstName, lastName, role]) => ({
    key,
    firstName,
    lastName,
    email: at(key),
    team: {
      key: team,
      role: role === 'admin' ? 'owner' : 'member',
      isPlayer: false
    },
    roles: role === 'admin' ? [] : [{ on: 'team', role }]
  }))
}

function player(
  team: TeamKey,
  key: string,
  firstName: string,
  lastName: string
): SeedPerson {
  return {
    key,
    firstName,
    lastName,
    email: at(key),
    team: { key: team, role: 'member', isPlayer: true }
  }
}

function parent(
  team: TeamKey,
  key: string,
  firstName: string,
  lastName: string
): SeedPerson {
  return {
    key,
    firstName,
    lastName,
    email: at(key),
    team: { key: team, role: 'member', isPlayer: false }
  }
}

function guardian(
  of: string,
  key: string,
  firstName: string,
  lastName: string
): SeedPerson {
  return { key, firstName, lastName, email: at(key), guardianOf: of }
}

/** The year and month of birth `born` puts before `now`'s month, in UTC. */
export function birthMonthOf(
  now: Date,
  born: { years: number; months: number }
): { year: number; month: number } {
  const months =
    now.getUTCFullYear() * 12 +
    now.getUTCMonth() -
    born.years * 12 -
    born.months
  return { year: Math.floor(months / 12), month: (months % 12) + 1 }
}

export interface SeededPerson {
  key: string
  userId: number
  name: string
  email: string | null
  /** Null for the person with no way to sign in. */
  password: string | null
}

export interface ChatSeed {
  leagueId: string
  seasonId: string
  teams: Record<TeamKey, string>
  games: Record<GameKey, string>
  videoId: string
  people: Record<string, SeededPerson>
}

export interface ChatSeedOptions {
  /** Today, from which the games' dates are worked out. */
  now?: Date
  /** Everybody's password; made up per person when not given. */
  password?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Builds the fixture, or brings an earlier build of it back to it. */
export async function chatSeed(
  db: Kysely<Database>,
  options: ChatSeedOptions = {}
): Promise<ChatSeed> {
  const now = options.now ?? new Date()
  return await db.transaction().execute(async trx => {
    const leagueId = await upsertLeague(trx)
    const seasonId = await upsertSeason(trx, leagueId)
    const teams: Record<TeamKey, string> = {
      hawks: await upsertTeam(trx, 'hawks', 'Hawks', seasonId),
      eagles: await upsertTeam(trx, 'eagles', 'Eagles', seasonId),
      owls: await upsertTeam(trx, 'owls', 'Owls', seasonId)
    }

    const day = (days: number): Date => {
      const date = new Date(now.getTime() + days * DAY_MS)
      date.setUTCHours(17, 0, 0, 0)
      return date
    }
    const games: Record<GameKey, string> = {
      hawksOwlsFinal: await upsertGame(trx, 'hawksOwlsFinal', {
        season_id: seasonId,
        home_team_id: teams.hawks,
        away_team_id: teams.owls,
        start_at: day(-7),
        venue: 'Northpoint Field 1',
        status: 'final',
        home_score: 6,
        away_score: 3
      }),
      hawksOwlsNext: await upsertGame(trx, 'hawksOwlsNext', {
        season_id: seasonId,
        home_team_id: teams.owls,
        away_team_id: teams.hawks,
        start_at: day(7),
        venue: 'Northpoint Field 2',
        status: 'scheduled',
        home_score: null,
        away_score: null
      }),
      eaglesHawksNext: await upsertGame(trx, 'eaglesHawksNext', {
        season_id: seasonId,
        home_team_id: teams.eagles,
        away_team_id: teams.hawks,
        start_at: day(8),
        venue: 'Northpoint Field 1',
        status: 'scheduled',
        home_score: null,
        away_score: null
      })
    }
    const videoId = await upsertVideo(trx, games.hawksOwlsFinal, day(-7))

    const scopeOf = (
      on: 'team' | 'season' | 'league',
      team?: TeamKey
    ): string =>
      on === 'league'
        ? leagueId
        : on === 'season'
          ? seasonId
          : teams[team ?? 'hawks']

    const people: Record<string, SeededPerson> = {}
    for (const person of SEED_PEOPLE) {
      const password =
        person.email == null
          ? null
          : (options.password ?? randomBytes(9).toString('base64url'))
      const userId = await upsertPerson(trx, person, password, now)
      const team = person.team
      if (team != null) {
        await trx
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: userId,
            team_id: teams[team.key],
            role: team.role,
            is_player: team.isPlayer
          })
          .onConflict(oc =>
            oc.columns(['user_id', 'team_id']).doUpdateSet({
              role: team.role,
              is_player: team.isPlayer
            })
          )
          .execute()
      }
      for (const role of person.roles ?? []) {
        await trx
          .insertInto('scope_roles')
          .values({
            id: makeId('scopeRole'),
            user_id: userId,
            scope_type: role.on,
            scope_id: scopeOf(role.on, person.team?.key),
            role: role.role
          })
          .onConflict(oc =>
            oc
              .columns(['user_id', 'scope_type', 'scope_id', 'role'])
              .doNothing()
          )
          .execute()
      }
      for (const team of person.follows ?? []) {
        await setFollow(trx, userId, { kind: 'team', id: teams[team] }, true)
      }
      people[person.key] = {
        key: person.key,
        userId,
        name: `${person.firstName} ${person.lastName}`,
        email: person.email,
        password
      }
    }

    // Guardians last, once the players they guard are on their teams.
    for (const person of SEED_PEOPLE) {
      if (person.guardianOf == null) continue
      const ward = SEED_PEOPLE.find(item => item.key === person.guardianOf)
      const wardId = people[person.guardianOf]?.userId
      if (ward?.team == null || wardId == null) {
        throw new Error(`${person.key} guards nobody on a team`)
      }
      await linkGuardian(
        trx,
        wardId,
        people[person.key].userId,
        teams[ward.team.key],
        null
      )
    }

    return { leagueId, seasonId, teams, games, videoId, people }
  })
}

type Trx = Kysely<Database>

/** The id of the row a `chatSeed` external id names, if it exists. */
async function seeded(
  trx: Trx,
  kind: string,
  key: string
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('external_ids')
    .select(['entity_id'])
    .where('system', '=', SYSTEM)
    .where('kind', '=', kind)
    .where('external_id', '=', key)
    .executeTakeFirst()
  return row?.entity_id
}

async function remember(
  trx: Trx,
  kind: string,
  key: string,
  entityId: string
): Promise<void> {
  await trx
    .insertInto('external_ids')
    .values({
      id: makeId('externalId'),
      entity_type: kind,
      entity_id: entityId,
      system: SYSTEM,
      kind,
      external_id: key
    })
    .execute()
}

async function upsertLeague(trx: Trx): Promise<string> {
  const held = await seeded(trx, 'league', 'qpll')
  if (held != null) {
    await trx
      .updateTable('leagues')
      .set({ name: 'QPLL' })
      .where('id', '=', held)
      .execute()
    return held
  }
  const id = makeId('league')
  await trx.insertInto('leagues').values({ id, name: 'QPLL' }).execute()
  await remember(trx, 'league', 'qpll', id)
  return id
}

async function upsertSeason(trx: Trx, leagueId: string): Promise<string> {
  const held = await seeded(trx, 'season', 'spring2027')
  const values = {
    league_id: leagueId,
    name: 'Spring 2027',
    year: 2027,
    term: 'Spring'
  }
  if (held != null) {
    await trx
      .updateTable('seasons')
      .set(values)
      .where('id', '=', held)
      .execute()
    return held
  }
  const id = makeId('season')
  await trx
    .insertInto('seasons')
    .values({ id, ...values })
    .execute()
  await remember(trx, 'season', 'spring2027', id)
  return id
}

async function upsertTeam(
  trx: Trx,
  key: TeamKey,
  name: string,
  seasonId: string
): Promise<string> {
  let id = await seeded(trx, 'team', key)
  if (id == null) {
    id = makeId('team')
    await trx.insertInto('teams').values({ id, name }).execute()
    await remember(trx, 'team', key, id)
  } else {
    await trx
      .updateTable('teams')
      .set({ name, kind: 'full', merged_into: null })
      .where('id', '=', id)
      .execute()
  }
  await trx
    .insertInto('season_teams')
    .values({ season_id: seasonId, team_id: id })
    .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
    .execute()
  return id
}

interface GameValues {
  season_id: string
  home_team_id: string
  away_team_id: string
  start_at: Date
  venue: string
  status: 'scheduled' | 'final'
  home_score: number | null
  away_score: number | null
}

async function upsertGame(
  trx: Trx,
  key: GameKey,
  values: GameValues
): Promise<string> {
  const held = await seeded(trx, 'game', key)
  if (held != null) {
    await trx.updateTable('games').set(values).where('id', '=', held).execute()
    return held
  }
  const id = makeId('game')
  await trx
    .insertInto('games')
    .values({ id, ...values })
    .execute()
  await remember(trx, 'game', key, id)
  return id
}

async function upsertVideo(
  trx: Trx,
  gameId: string,
  startAt: Date
): Promise<string> {
  const values = {
    game_id: gameId,
    kind: 'program' as const,
    title: 'Owls at Hawks',
    storage: 'local' as const,
    status: 'ready' as const,
    start_at: startAt,
    duration_sec: 5400
  }
  const held = await seeded(trx, 'video', 'hawksOwlsFinal')
  if (held != null) {
    await trx.updateTable('videos').set(values).where('id', '=', held).execute()
    return held
  }
  const id = makeId('video')
  await trx
    .insertInto('videos')
    .values({ id, ...values })
    .execute()
  await remember(trx, 'video', 'hawksOwlsFinal', id)
  return id
}

async function upsertPerson(
  trx: Trx,
  person: SeedPerson,
  password: string | null,
  now: Date
): Promise<number> {
  const born = person.born == null ? undefined : birthMonthOf(now, person.born)
  const values = {
    display_name: `${person.firstName} ${person.lastName}`,
    first_name: person.firstName,
    last_name: person.lastName,
    is_admin: person.isAdmin === true,
    password_hash: password == null ? null : await hashPassword(password),
    login_enabled: password != null,
    birth_year: born?.year ?? null,
    birth_month: born?.month ?? null,
    merged_into: null,
    updated_at: new Date()
  }
  const held = await seeded(trx, 'user', person.key)
  if (held != null) {
    await trx
      .updateTable('users')
      .set(values)
      .where('id', '=', Number(held))
      .execute()
    return Number(held)
  }
  const taken = new Set(
    (await trx.selectFrom('users').select('id').execute()).map(row => row.id)
  )
  const minted = mintUserId(id => taken.has(id))
  await trx
    .insertInto('users')
    .values({ id: minted.userId, legacyId: minted.legacyId, ...values })
    .execute()
  if (person.email != null) {
    const added = await addEmail(trx, minted.userId, person.email, {
      isPrimary: true,
      source: 'manual',
      verifiedAt: new Date()
    })
    if (added.heldBy != null) {
      throw new Error(
        `${person.email} already belongs to user ${added.heldBy}, outside the fixture`
      )
    }
  }
  await remember(trx, 'user', person.key, String(minted.userId))
  return minted.userId
}

/** The fixture as a table to read the passwords off. */
export function describeSeed(seed: ChatSeed): string {
  const lines = [
    `QPLL ${seed.leagueId}  Spring 2027 ${seed.seasonId}`,
    `Hawks ${seed.teams.hawks}  Eagles ${seed.teams.eagles}  Owls ${seed.teams.owls}`,
    `Hawks v Owls (final) ${seed.games.hawksOwlsFinal}  video ${seed.videoId}`,
    `Owls v Hawks (next week) ${seed.games.hawksOwlsNext}`,
    `Eagles v Hawks (next week) ${seed.games.eaglesHawksNext}`,
    ''
  ]
  for (const person of Object.values(seed.people)) {
    lines.push(
      [
        person.key.padEnd(3),
        person.name.padEnd(16),
        String(person.userId).padEnd(17),
        (person.email ?? '(no account)').padEnd(24),
        person.password ?? ''
      ]
        .join(' ')
        .trimEnd()
    )
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The chat seed does not run in production')
  }
  // Loaded here rather than at the top, so a test importing this module
  // never reads a serverConfig.json.
  const { serverConfig } = await import('../serverConfig')
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const password = process.env.TS_CHAT_SEED_PASSWORD
    const seed = await chatSeed(db, {
      password: password == null || password === '' ? undefined : password
    })
    console.log(describeSeed(seed))
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/chatSeed.ts') || entry.endsWith('/chatSeed.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
