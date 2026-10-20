import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { Kysely } from 'kysely'
import { Pool } from 'pg'
import { createClient } from 'redis'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../common/gumboPlay'
import { makeId } from '../common/ids'
import {
  cleanAction,
  mapPlayers,
  type ScoringAction
} from '../common/scoring/actions'
import { newSetup } from '../common/scoring/lineup'
import {
  type EventStore,
  ScoringSession,
  type SessionContext
} from '../common/scoring/session'
import { userIdOfGumbo } from '../common/userId'
import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { testDatabaseUrl } from '../migrate/testDatabase'
import { hashToken } from '../server/auth/tokens'
import { type Database, makeDatabase } from '../server/db/database'
import { postGamePlays, readPlays } from '../server/events/postPlays'
import {
  makeScoreboardClient,
  makeScoreboardStore,
  type ScoreboardClient,
  type ScoreboardStore
} from '../server/scoreboard/scoreboardStore'
import { mintUserId } from './historicalUserIds'
import { insertFixtureUsers } from './insertFixtureUsers'

/**
 * What the scoreboard's server tests share: a real Redis, a random prefix per
 * test, a scratch database, and the situations fixture.
 */

export const testRedisUrl =
  process.env.TS_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15'

/**
 * Fails, rather than skipping, when Redis is not there: a scoreboard test
 * that quietly did not run is a scoreboard nobody tested.
 */
export async function requireRedis(): Promise<void> {
  const probe = createClient({
    url: testRedisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 2000 }
  })
  probe.on('error', () => undefined)
  try {
    await probe.connect()
    await probe.ping()
  } catch (error) {
    throw new Error(
      `Redis is not reachable at ${testRedisUrl} (TS_TEST_REDIS_URL): ${String(error)}`
    )
  } finally {
    if (probe.isOpen) await probe.close()
  }
}

export function testPrefix(): string {
  return `ts-test:${randomBytes(6).toString('hex')}`
}

export const quiet = (): void => undefined

export async function connectedClient(
  log: (message: string) => void = quiet
): Promise<ScoreboardClient> {
  const client = makeScoreboardClient(testRedisUrl, log)
  await client.connect()
  return client
}

/** A store on its own connection, with a clock the test may move. */
export async function testStore(
  prefix: string,
  now?: () => number
): Promise<{ client: ScoreboardClient; store: ScoreboardStore }> {
  const client = await connectedClient()
  return { client, store: makeScoreboardStore({ client, prefix, now }) }
}

/** Deletes every key under a prefix. */
export async function dropPrefix(prefix: string): Promise<void> {
  const client = await connectedClient()
  for await (const keys of client.scanIterator({ MATCH: `${prefix}:*` })) {
    if (keys.length > 0) await client.del(keys)
  }
  await client.close()
}

/** A database of its own, migrated, and how to drop it. */
export async function scratchDatabase(
  label: string
): Promise<{ db: Kysely<Database>; drop: () => Promise<void> }> {
  const name = `teamstation_${label}_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`
  const admin = new Pool({ connectionString: testDatabaseUrl })
  await admin.query(`create database ${name}`)
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const pool = new Pool({ connectionString: url })
  await migrateUp(pool, migrations)
  await pool.end()
  const db = makeDatabase(url)
  return {
    db,
    drop: async () => {
      await db.destroy()
      await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
    }
  }
}

export interface Person {
  userId: string
  gumboId: number
  token: string
}

/** A user with a session, and optionally a team he owns. */
export async function addPerson(
  db: Kysely<Database>,
  label: string,
  options: { isAdmin?: boolean; owns?: string } = {}
): Promise<Person> {
  const made = mintUserId(() => false)
  const now = new Date()
  await insertFixtureUsers(db, {
    id: userIdOfGumbo(made.userId),
    legacyId: made.legacyId,
    display_name: label,
    is_admin: options.isAdmin === true,
    created_at: now,
    updated_at: now
  })
  const token = `tok_scoreboard_${label}_${randomBytes(8).toString('hex')}`
  await db
    .insertInto('auth_sessions')
    .values({
      id: makeId('authSession'),
      user_id: userIdOfGumbo(made.userId),
      token_hash: hashToken(token),
      created_at: now,
      expires_at: new Date(now.getTime() + 3_600_000)
    })
    .execute()
  if (options.owns != null) {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(made.userId),
        team_id: options.owns,
        role: 'owner'
      })
      .execute()
  }
  return { userId: userIdOfGumbo(made.userId), gumboId: made.userId, token }
}

export async function addTeam(
  db: Kysely<Database>,
  name: string
): Promise<string> {
  const id = makeId('team')
  await db.insertInto('teams').values({ id, name }).execute()
  return id
}

export async function addGame(
  db: Kysely<Database>,
  game: {
    homeTeamId: string
    awayTeamId: string
    startAt: Date
    status?: 'scheduled' | 'inProgress' | 'final' | 'cancelled'
    homeScore?: number
  }
): Promise<string> {
  const id = makeId('game')
  await db
    .insertInto('games')
    .values({
      id,
      home_team_id: game.homeTeamId,
      away_team_id: game.awayTeamId,
      start_at: game.startAt,
      status: game.status ?? 'scheduled',
      home_score: game.homeScore ?? null
    })
    .execute()
  return id
}

/** Waits for a condition, polling; throws with `what` when it never holds. */
export async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * `scoreboardSituations.actions.json` is an action list with named points in
 * it: a top half with a run, then a bottom half to runners on first and
 * third at 2-1, then its third out.
 */
export const SITUATIONS_FIXTURE =
  'src/common/scoring/fixtures/scoreboardSituations.actions.json'

export type SituationEntry = ScoringAction | { point: string }

export function situationEntries(): SituationEntry[] {
  return JSON.parse(
    readFileSync(SITUATIONS_FIXTURE, 'utf8')
  ) as SituationEntry[]
}

/** The fixture's actions, without its named points. */
export function situationActions(
  setup: SessionContext['setup']
): ScoringAction[] {
  return situationEntries()
    .filter((entry): entry is ScoringAction => !('point' in entry))
    .map(action => {
      const converted = cleanAction(
        mapPlayers(action, value => {
          const id = setup.tagOrder[Number(value) - 1]
          if (id == null)
            throw new Error('Fixture player has no persisted identity')
          return id
        })
      )
      if ('problem' in converted) throw new Error(converted.problem.message)
      return converted.action
    })
}

/** Two teams with nine players each, which a game between them can score. */
export async function addScorableTeams(
  db: Kysely<Database>,
  names: { home: string; away: string }
): Promise<Pick<SessionContext, 'teams' | 'setup'>> {
  const teams = {
    home: {
      id: await addTeam(db, names.home),
      name: names.home,
      logoUrl: null
    },
    away: { id: await addTeam(db, names.away), name: names.away, logoUrl: null }
  }
  const now = new Date()
  const held = new Set<number>()
  const roster = { home: [] as number[], away: [] as number[] }
  for (const side of ['away', 'home'] as const) {
    for (let i = 0; i < 9; i++) {
      const made = mintUserId(id => held.has(id))
      held.add(made.userId)
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(made.userId),
        legacyId: made.legacyId,
        display_name: `${names[side]} ${i + 1}`,
        created_at: now,
        updated_at: now
      })
      roster[side].push(made.userId)
    }
  }
  const setup = newSetup(teams, {
    away: roster.away.map((userId, i) => ({
      userId: userIdOfGumbo(userId),
      gumboId: userId,
      shortName: `Away ${i + 1}`
    })),
    home: roster.home.map((userId, i) => ({
      userId: userIdOfGumbo(userId),
      gumboId: userId,
      shortName: `Home ${i + 1}`
    }))
  })
  return { teams, setup }
}

/** Scores actions on a game the way the app does, writing straight to the database. */
export async function scoreDirectly(
  db: Kysely<Database>,
  gameId: string,
  context: Pick<SessionContext, 'teams' | 'setup'>,
  actions: ScoringAction[]
): Promise<void> {
  const load = async (id: string): ReturnType<EventStore['load']> => {
    const game = await db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return {
      plays: (await readPlays(db, id)).map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null
    }
  }
  const store: EventStore = {
    load,
    save: async (id, change) => {
      await postGamePlays(
        db,
        id,
        asPostEventsBody({
          ...change,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
      return await load(id)
    }
  }
  const session = await ScoringSession.open(
    store,
    gameId,
    { gamePk: gameId, ...context },
    { setTimer: () => null, clearTimer: () => undefined }
  )
  for (const action of actions) {
    const problems = session.apply(action).problems
    if (problems.length > 0) throw new Error(problems[0].message)
    await session.flush()
  }
}
