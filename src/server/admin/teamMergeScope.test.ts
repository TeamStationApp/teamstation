import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { openLoadDatabase } from '../../../tools/dbLoad/database'
import { seedFixture, taggedIn } from '../../../tools/dbLoad/fixture'
import { TEST_AMOUNTS } from '../../../tools/dbLoad/testAmounts'
import { openScratch, type Scratch } from '../../../tools/dbLoad/testSupport'
import { HttpError } from '../../common/errors'
import { asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { asTeamPlayersBody } from '../../common/teamMembers'
import {
  GAME_TEAMS_ROUNDS,
  lockGameTeams,
  lockKeys,
  lockKeysShared,
  teamKey
} from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { addPlayers } from '../teams/addPlayers'
import { insertUser } from '../users/insertUser'
import { mergeTeams } from './mergeTeams'
import { closeInto } from './people'

/** Whether a transaction waits for the advisory lock on `key`. */
async function waitsOnKey(
  db: Kysely<Database>,
  key: string,
  mode?: 'ShareLock' | 'ExclusiveLock'
): Promise<boolean> {
  const { rows } = await sql<{ waiting: boolean }>`
    select exists(select 1 from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)
        and (${mode ?? null}::text is null or mode = ${mode ?? null})
    ) as waiting`.execute(db)
  return rows[0].waiting
}

/** Whether a transaction waits for another's row (a tuple or its xid). */
async function waitsOnRow(db: Kysely<Database>): Promise<boolean> {
  const { rows } = await sql<{ waiting: boolean }>`
    select exists(select 1 from pg_locks
      where locktype in ('transactionid', 'tuple') and not granted
        and pid in (select pid from pg_stat_activity where datname = current_database())
    ) as waiting`.execute(db)
  return rows[0].waiting
}

async function until(
  what: string,
  check: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await setTimeout(10)
  }
  throw new Error(`Never saw: ${what}`)
}

/** Settles `promise`, or says it did not within `ms`. */
async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  return await Promise.race([
    promise,
    setTimeout(ms).then(() => {
      throw new Error(`Still waiting after ${ms} ms`)
    })
  ])
}

/** Whether `promise` is still pending after a short wait. */
async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending')
  return (
    (await Promise.race([
      promise.then(() => null),
      setTimeout(150, marker)
    ])) === marker
  )
}

/** A merge paused at its `events` update, after every lock it takes first. */
function heldMerge(
  db: Kysely<Database>,
  fromTeamId: string,
  intoTeamId: string
): {
  done: Promise<unknown>
  paused: Promise<void>
  release: () => void
} {
  let release = (): void => {}
  let reached = (): void => {}
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  const paused = new Promise<void>(resolve => {
    reached = resolve
  })
  const updates = new Set<unknown>()
  const done = mergeTeams(
    db.withPlugin({
      transformQuery(args) {
        if (JSON.stringify(args.node).includes('update events set'))
          updates.add(args.queryId)
        return args.node
      },
      async transformResult(args) {
        if (updates.has(args.queryId)) {
          reached()
          await barrier
        }
        return args.result
      }
    }),
    { fromTeamId, intoTeamId, apply: true }
  )
  done.catch(() => undefined)
  return { done, paused, release }
}

/** One outside scorer's play, naming nobody by id. */
const onePlay = (batter: string): ReturnType<typeof asPostEventsBody> =>
  asPostEventsBody({
    mode: 'replace',
    source: { system: 'acme' },
    plays: [
      {
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
        result: { eventType: 'single', awayScore: 0, homeScore: 0 },
        matchup: { batter: { fullName: batter } }
      }
    ]
  })

describe('a team merge locks only its two teams', function () {
  this.timeout(180_000)

  let scratch: Scratch
  let db: Kysely<Database>
  let admin: string
  const run = 'teamMergeScope'

  const person = async (name: string): Promise<string> =>
    await insertUser(db, {
      display_name: name,
      first_name: name,
      last_name: 'Scope'
    })
  const team = async (name: string): Promise<string> => {
    const id = makeId('team')
    await db
      .insertInto('teams')
      .values({ id, name, kind: 'external' })
      .execute()
    return id
  }
  const member = async (teamId: string, userId: string): Promise<void> => {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: teamId,
        user_id: userId,
        is_player: true
      })
      .execute()
  }
  const game = async (home: string, away: string): Promise<string> => {
    const id = makeId('game')
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    return id
  }
  const teamsOf = async (
    gameId: string
  ): Promise<{ home_team_id: string; away_team_id: string }> =>
    await db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
  const playsOf = async (gameId: string): Promise<number> =>
    (
      await db
        .selectFrom('events')
        .select('id')
        .where('gameId', '=', gameId)
        .execute()
    ).length

  before(async function () {
    scratch = await openScratch('team_merge_scope')
    await seedFixture(scratch.db, {
      runId: run,
      scale: 'small',
      overrides: TEST_AMOUNTS
    })
    // Room for a merge, two posts, an import, a person merge and the checks.
    db = openLoadDatabase(scratch.url, { max: 12 })
    admin = await insertUser(db, {
      display_name: 'Scope Admin',
      is_admin: true
    })
  })
  after(async function () {
    await db?.destroy()
    await scratch?.drop()
  })

  interface Shape {
    /** The team the merge goes away. */
    from: string
    into: string
    /** The merged team whose game is posted to and whose member is moved. */
    locked: string
    gameOfLocked: string
    /** One of `locked`'s members. */
    memberOfLocked: string
  }

  /**
   * While the merge is held: a post on another game completes, one on the
   * locked team's game waits on that team's key, an import into another
   * team of a person on the locked team waits only on the person's row, and
   * a person merge of that member waits. Released, all of them finish.
   */
  const whileHeld = async (shape: Shape): Promise<void> => {
    const teamC = await team('Scope C')
    const teamD = await team('Scope D')
    const gameCD = await game(teamC, teamD)
    const keeper = await person('Keeper')
    const externalId = {
      system: 'scope',
      kind: 'person',
      id: randomUUID()
    }
    await db
      .insertInto('external_ids')
      .values({
        id: randomUUID(),
        entity_type: 'user',
        entity_id: shape.memberOfLocked,
        system: externalId.system,
        kind: externalId.kind,
        external_id: externalId.id
      })
      .execute()

    const merge = heldMerge(db, shape.from, shape.into)
    const pending: Array<Promise<unknown>> = [merge.done]
    try {
      await within(merge.paused)

      await within(postGamePlays(db, gameCD, onePlay('Other Game')))
      expect(await playsOf(gameCD)).equals(1)

      const held: string[][] = []
      const post = postGamePlays(
        db,
        shape.gameOfLocked,
        onePlay('Locked Game'),
        undefined,
        async trx => {
          const { rows } = await sql<{ key: string }>`
            select k as key from unnest(${[
              teamKey(shape.from),
              teamKey(shape.into)
            ]}::text[]) as k
            where exists (select 1 from pg_locks
              where pid = pg_backend_pid() and locktype = 'advisory'
                and granted and mode = 'ShareLock'
                and ((classid::bigint << 32) | objid::bigint) = hashtextextended(k, 0))`.execute(
            trx
          )
          // Which keys, not their order: the database's collation and
          // JavaScript's sort disagree on ids that differ in case or `-`/`_`.
          held.push(rows.map(row => row.key).sort())
        }
      )
      post.catch(() => undefined)
      pending.push(post)
      await until(
        'the post waiting on the merged team',
        async () => await waitsOnKey(db, teamKey(shape.locked), 'ShareLock')
      )
      expect(await stillWaiting(post)).equals(true)

      const imported = addPlayers(
        db,
        { userId: admin, isAdmin: true, scopes: [] },
        teamC,
        asTeamPlayersBody({ players: [{ externalId, jersey: '7' }] }).players
      )
      imported.catch(() => undefined)
      pending.push(imported)
      // Its team's key is free: it waits only for the person's row, which
      // the merge took first, and holds nothing the merge goes on to need.
      await until(
        'the import waiting on the person',
        async () => await waitsOnRow(db)
      )
      expect(await waitsOnKey(db, teamKey(teamC))).equals(false)

      const closing = closeInto(db, shape.memberOfLocked, keeper)
      closing.catch(() => undefined)
      pending.push(closing)
      await until(
        'the person merge waiting on the parent graph',
        async () =>
          await waitsOnKey(db, 'creation:parent-graph', 'ExclusiveLock')
      )
      expect(await stillWaiting(closing)).equals(true)

      merge.release()
      expect(await within(merge.done)).includes({ applied: true })
      await within(post)
      expect(await playsOf(shape.gameOfLocked)).equals(1)
      expect((await within(imported)).counts).includes({ error: 0 })
      expect((await within(closing)).closed).equals(true)
      // The post read the game under the team it had, waited, and took the
      // key of the team it has now.
      expect(held).deep.equals([
        (shape.locked === shape.from
          ? [teamKey(shape.from), teamKey(shape.into)]
          : [teamKey(shape.into)]
        ).sort()
      ])
      const moved = await teamsOf(shape.gameOfLocked)
      expect([moved.home_team_id, moved.away_team_id]).includes(shape.into)
      expect([moved.home_team_id, moved.away_team_id]).not.includes(shape.from)
      const placed = await db
        .selectFrom('memberships')
        .select('user_id')
        .where('team_id', '=', teamC)
        .execute()
      expect(placed.map(row => row.user_id)).deep.equals([keeper])
    } finally {
      merge.release()
      await Promise.allSettled(pending)
    }
  }

  it('lets other teams post, import and merge people while a merge of A and B runs, and holds A’s writers', async () => {
    const a = await team('Scope A')
    const b = await team('Scope B')
    const e = await team('Scope E')
    const onA = await person('On A')
    await member(a, onA)
    await member(b, await person('On B'))
    const gameOfA = await game(a, e)
    // A play for the merge to move.
    await db
      .insertInto('events')
      .values({
        id: makeId('event'),
        gameId: gameOfA,
        battingTeamId: a,
        source: 'external',
        gumbo: onePlay('Before').plays[0]
      })
      .execute()
    await whileHeld({
      from: a,
      into: b,
      locked: a,
      gameOfLocked: gameOfA,
      memberOfLocked: onA
    })
  })

  for (const label of ['worst.teamKept', 'worst.teamOpponent'])
    it(`does the same for a merge into the fixture’s ${label}`, async () => {
      const worst = (await taggedIn(scratch.db, run, 'team')).get(label)!
      expect(worst).to.be.a('string')
      const copy = await team(`Scope copy of ${label}`)
      await member(copy, await person('On Copy'))
      await game(copy, await team('Scope Copy Opponent'))
      const onWorst = await person('On Worst')
      await member(worst, onWorst)
      const gameOfWorst = await game(worst, await team('Scope Worst Opponent'))
      await whileHeld({
        from: copy,
        into: worst,
        locked: worst,
        gameOfLocked: gameOfWorst,
        memberOfLocked: onWorst
      })
    })

  it('gives up with unavailable after five reads of a game’s teams that never agree', async () => {
    const gameId = await game(await team('Stub Home'), await team('Stub Away'))
    let reads = 0
    const moving = db.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        const rows = args.result.rows as Array<Record<string, unknown>>
        if (rows.length === 1 && 'home_team_id' in rows[0]) {
          reads += 1
          return {
            ...args.result,
            rows: [{ home_team_id: `tem_moved${reads}`, away_team_id: 'x' }]
          }
        }
        return args.result
      }
    })
    const error = await moving
      .transaction()
      .execute(async trx => await lockGameTeams(trx, gameId))
      .then(
        () => undefined,
        (caught: unknown) => caught
      )
    expect(error).instanceOf(HttpError)
    expect((error as HttpError).code).equals('unavailable')
    expect(reads).equals(GAME_TEAMS_ROUNDS + 1)
    // A game that is not there has no teams to lock.
    expect(
      await db
        .transaction()
        .execute(async trx => await lockGameTeams(trx, 'gam_missing'))
    ).equals(undefined)
  })

  it('answers a game deleted between its two reads as no game', async () => {
    const gameId = await game(await team('Gone Home'), await team('Gone Away'))
    let reads = 0
    const vanishing = db.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        const rows = args.result.rows as Array<Record<string, unknown>>
        if (rows.length === 1 && 'home_team_id' in rows[0]) {
          reads += 1
          if (reads > 1) return { ...args.result, rows: [] }
        }
        return args.result
      }
    })
    expect(
      await vanishing
        .transaction()
        .execute(async trx => await lockGameTeams(trx, gameId))
    ).equals(undefined)
  })

  it('lets two shared holders of a key in together, and makes an exclusive taker wait for both', async () => {
    const key = `scope:${randomUUID()}`
    let release = (): void => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const holding: Array<Promise<void>> = []
    const holders: Array<Promise<void>> = []
    for (let i = 0; i < 2; i++) {
      let held = (): void => {}
      holding.push(
        new Promise<void>(resolve => {
          held = resolve
        })
      )
      holders.push(
        db.transaction().execute(async trx => {
          await lockKeysShared(trx, [key, key])
          held()
          await barrier
        })
      )
    }
    let exclusive: Promise<void> | undefined
    try {
      await within(Promise.all(holding))
      exclusive = db.transaction().execute(async trx => {
        await lockKeys(trx, [key])
      })
      exclusive.catch(() => undefined)
      await until(
        'the exclusive taker waiting',
        async () => await waitsOnKey(db, key, 'ExclusiveLock')
      )
      expect(await stillWaiting(exclusive)).equals(true)
      release()
      await within(Promise.all(holders))
      await within(exclusive)
    } finally {
      release()
      await Promise.allSettled([...holders, exclusive])
    }
    // No keys: no statement.
    await db.transaction().execute(async trx => {
      await lockKeysShared(trx, [])
    })
  })

  it('takes the people before a users update over several teams, or waits for one, without a deadlock', async () => {
    // Two people on A, B and C each, so the update is one statement over
    // several people and teams.
    const a = await team('Users A')
    const b = await team('Users B')
    const c = await team('Users C')
    const people = [await person('Multi One'), await person('Multi Two')]
    for (const userId of people)
      for (const teamId of [a, b, c]) await member(teamId, userId)
    await game(a, await team('Users Opponent'))
    const rename = async (name: string): Promise<unknown> =>
      await sql`update users set display_name = ${name} || ' ' || id
        where id = any(${people}::text[])`.execute(db)

    // The merge first: the update waits for the people's rows.
    const merge = heldMerge(db, a, b)
    let renaming: Promise<unknown> | undefined
    try {
      await within(merge.paused)
      renaming = rename('Renamed')
      renaming.catch(() => undefined)
      await until(
        'the update waiting on the people',
        async () => await waitsOnRow(db)
      )
      merge.release()
      await within(Promise.all([merge.done, renaming]))
    } finally {
      merge.release()
      await Promise.allSettled([merge.done, renaming])
    }

    // The update first, held open with every team's version bumped: the
    // merge waits for it at its first row, before any membership.
    const connection = await db.connection().execute(async conn => {
      await sql`begin`.execute(conn)
      await sql`update users set display_name = 'Held ' || id
        where id = any(${people}::text[])`.execute(conn)
      const merged = mergeTeams(db, {
        fromTeamId: b,
        intoTeamId: c,
        apply: true
      })
      merged.catch(() => undefined)
      try {
        await until(
          'the merge waiting on the people',
          async () => await waitsOnRow(db)
        )
        expect(await stillWaiting(merged)).equals(true)
      } finally {
        await sql`commit`.execute(conn)
      }
      return await within(merged)
    })
    expect(connection).includes({ applied: true })
    const members = await db
      .selectFrom('memberships')
      .select('user_id')
      .where('team_id', '=', c)
      .orderBy('user_id')
      .execute()
    expect(members.map(row => row.user_id)).deep.equals([...people].sort())
  })

  it('removes duplicate memberships of the kept team only', async () => {
    const from = await team('Dedupe From')
    const into = await team('Dedupe Into')
    const other = await team('Dedupe Other')
    const twice = await person('Twice')
    const onInto = await person('Twice Into')
    // Duplicates cannot be made with the constraint in place; this merge's
    // dedupe is what would clear any the merge left.
    await sql`alter table memberships drop constraint memberships_user_id_team_id_key`.execute(
      db
    )
    try {
      for (let i = 0; i < 2; i++) {
        await member(other, twice)
        await member(into, onInto)
      }
      await member(from, await person('Moving'))
      await mergeTeams(db, { fromTeamId: from, intoTeamId: into, apply: true })
      const count = async (teamId: string, userId: string): Promise<number> =>
        (
          await db
            .selectFrom('memberships')
            .select('id')
            .where('team_id', '=', teamId)
            .where('user_id', '=', userId)
            .execute()
        ).length
      expect(await count(other, twice)).equals(2)
      expect(await count(into, onInto)).equals(1)
    } finally {
      await sql`delete from memberships where team_id = ${other}`.execute(db)
      await sql`alter table memberships add constraint memberships_user_id_team_id_key unique (user_id, team_id)`.execute(
        db
      )
    }
  })
})
