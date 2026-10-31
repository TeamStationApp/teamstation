import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { TagDocument } from '../../common/eventTags'
import { tagTargets } from '../../common/eventTags'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { eventTagsNeedRepair } from '../events/eventTags'
import { postGamePlays } from '../events/postPlays'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import {
  bumpNotedScopes,
  noteScopeChange,
  readSyncClock,
  REVISION_HEADER
} from '../socket/syncRevision'
import { eventRoutes } from './events'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_events_read_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const TOKEN = 'tok_eventsread_0000000000000000000000'
const admin = mintUserId(() => false)
const home = 'tem_events_read_home'
const away = 'tem_events_read_away'

function play(atBatIndex: number): Record<string, unknown> {
  return {
    about: {
      atBatIndex,
      inning: 1,
      halfInning: 'top',
      isScoringPlay: false
    },
    count: { outs: 0 },
    result: {
      eventType: 'single',
      awayScore: 0,
      homeScore: 0,
      description: 'Single'
    },
    playEvents: [{ isPitch: true }]
  }
}

interface Read {
  status: number
  revision: string
  plays: Array<{ id: string; gumbo: TagDocument }>
  playsDigest: string
  generation: number
}

/** Fails rather than hangs when a read that must not wait, waits. */
async function atOnce<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<never>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('A read waited on a lock'))
    }, 5000)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

describe('reading a game without taking its row', function () {
  this.timeout(30000)

  let adminPool: Pool | undefined
  let db: Kysely<Database>
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    await insertFixtureUsers(db, [
      {
        id: userIdOfGumbo(admin.userId),
        legacyId: admin.legacyId,
        display_name: 'Read Tester',
        is_admin: true,
        created_at: now,
        updated_at: now
      }
    ])
    await db
      .insertInto('auth_sessions')
      .values({
        id: 'ses_events_read',
        user_id: userIdOfGumbo(admin.userId),
        token_hash: hashToken(TOKEN),
        created_at: now,
        expires_at: new Date(now.getTime() + 3_600_000)
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home' },
        { id: away, name: 'Away' }
      ])
      .execute()
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', eventRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (adminPool == null) return
    await db.destroy()
    await adminPool.query(`drop database if exists ${scratchName}`)
    await adminPool.end()
  })

  const newGame = async (id: string): Promise<string> => {
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date(),
        status: 'scheduled'
      })
      .execute()
    return id
  }

  const read = async (id: string): Promise<Read> => {
    const response = await fetch(`${base}/games/${id}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const body = (await response.json()) as Omit<Read, 'status' | 'revision'>
    return {
      ...body,
      status: response.status,
      revision: response.headers.get(REVISION_HEADER) ?? ''
    }
  }

  const post = async (
    id: string,
    plays: unknown[]
  ): Promise<{ status: number; playsDigest: string }> => {
    const response = await fetch(`${base}/games/${id}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mode: 'live',
        source: { system: 'teamstation' },
        plays
      })
    })
    const body = (await response.json()) as { playsDigest: string }
    return { status: response.status, playsDigest: body.playsDigest }
  }

  /** A write that left its plays with no tag identities, as an import may. */
  const stripTags = async (id: string): Promise<void> => {
    await sql`update events set gumbo = gumbo - 'tagTargets' where "gameId" = ${id}`.execute(
      db
    )
    expect(await eventTagsNeedRepair(db, id)).equals(true)
  }

  /** Runs `during` with a post open: game row and clock held, uncommitted. */
  const duringOpenPost = async <T>(
    id: string,
    plays: unknown[],
    during: () => Promise<T>
  ): Promise<T> =>
    await atomic(db, async trx => {
      await postGamePlays(trx, id, {
        mode: 'live',
        source: { system: 'teamstation' },
        plays
      } as unknown as Parameters<typeof postGamePlays>[2])
      await bumpNotedScopes(trx)
      return await during()
    })

  it('answers at once while a post holds the game and the clock, with what has committed', async function () {
    const id = await newGame('gam_read_open_post')
    expect((await post(id, [play(0)])).status).equals(200)
    const committed = await read(id)
    const reads = await duringOpenPost(id, [play(1)], async () => {
      // Readers do not wait for the post, nor for each other.
      return await atOnce(
        Promise.all(Array.from({ length: 8 }, async () => await read(id)))
      )
    })
    for (const each of reads) {
      expect(each.status).equals(200)
      expect(each.plays.length).equals(1)
      expect(each.playsDigest).equals(committed.playsDigest)
      expect(each.revision).equals(committed.revision)
    }
    const after = await read(id)
    expect(after.plays.length).equals(2)
    expect(BigInt(after.revision) > BigInt(committed.revision)).equals(true)
  })

  it('answers the revision its rows were read at, when a write commits in the middle of the read', async function () {
    const id = await newGame('gam_read_midway')
    expect((await post(id, [play(0)])).status).equals(200)
    const before = await read(id)
    // The read has its snapshot by the time it reaches this table, and waits.
    const hold = await db.connection().execute(async connection => {
      await sql`begin`.execute(connection)
      await sql`lock table event_tags in access exclusive mode`.execute(
        connection
      )
      const reading = read(id)
      for (;;) {
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::integer as waiting from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%event_tags%'
            and datname = current_database()`.execute(db)
        if (rows[0].waiting > 0) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      // The write takes the game row the read would have queued on.
      const revision = await atomic(db, async trx => {
        await trx
          .updateTable('games')
          .set({ play_generation: before.generation + 1 })
          .where('id', '=', id)
          .execute()
        noteScopeChange(trx, { gameId: id })
        return await bumpNotedScopes(trx)
      })
      await sql`rollback`.execute(connection)
      return { reading, revision: revision! }
    })
    const midway = await atOnce(hold.reading)
    // Its rows and its revision are of the moment before the write.
    expect(midway.generation).equals(before.generation)
    expect(midway.revision).equals(before.revision)
    expect(BigInt(hold.revision) > BigInt(midway.revision)).equals(true)
    const after = await read(id)
    expect(after.generation).equals(before.generation + 1)
    expect(after.revision).equals(hold.revision)
  })

  it('keeps a revision to one set of rows, and never answers newer than its rows, under concurrent posts', async function () {
    const id = await newGame('gam_read_concurrent')
    const writing = { going: true }
    const seen: Read[] = []
    const reader = async (): Promise<void> => {
      while (writing.going) seen.push(await read(id))
    }
    const readers = Array.from({ length: 4 }, reader)
    try {
      for (let index = 0; index < 15; index++) {
        const posted = await post(id, [play(index)])
        expect(posted.status).equals(200)
        // Once a post has answered, every read holds it.
        const own = await read(id)
        expect(own.playsDigest).equals(posted.playsDigest)
        seen.push(own)
      }
    } finally {
      writing.going = false
    }
    await Promise.all(readers)
    const byRevision = new Map<string, Read>()
    for (const each of seen) {
      expect(each.status).equals(200)
      const first = byRevision.get(each.revision)
      if (first != null) expect(each.playsDigest).equals(first.playsDigest)
      else byRevision.set(each.revision, each)
    }
    const ordered = [...byRevision.values()].sort((a, b) =>
      BigInt(a.revision) < BigInt(b.revision) ? -1 : 1
    )
    for (let at = 1; at < ordered.length; at++)
      expect(ordered[at].plays.length).greaterThan(
        ordered[at - 1].plays.length - 1
      )
    expect(ordered.at(-1)?.plays.length).equals(15)
  })

  it('finds nothing to repair after a post, the at-bat in progress included, and writes nothing when read', async function () {
    const id = await newGame('gam_read_fixed_point')
    expect((await post(id, [play(0), play(1)])).status).equals(200)
    expect(await eventTagsNeedRepair(db, id)).equals(false)
    // An at-bat of its own, and one at the index of a stored play.
    for (const atBatIndex of [2, 1]) {
      const current = play(atBatIndex)
      const response = await fetch(`${base}/games/${id}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          mode: 'live',
          source: { system: 'teamstation' },
          plays: [],
          currentPlay: {
            ...current,
            about: { ...(current.about as object), isComplete: false }
          }
        })
      })
      expect(response.status).equals(200)
      expect(await eventTagsNeedRepair(db, id)).equals(false)
    }
    const versions = async (): Promise<unknown> =>
      (
        await sql`select xmin::text as version from events where "gameId" = ${id}
          union all select xmin::text from games where id = ${id}
          order by 1`.execute(db)
      ).rows
    const before = await versions()
    await read(id)
    expect(await versions()).deep.equals(before)
  })

  it('says a missing game is not found', async function () {
    let status: unknown
    await eventTagsNeedRepair(db, 'gam_read_missing').catch(
      (error: unknown) => {
        status = (error as { status?: unknown }).status
      }
    )
    expect(status).equals(404)
  })

  it('repairs a game left unreconciled once, under its lock, for readers at the same time', async function () {
    const id = await newGame('gam_read_repair')
    expect((await post(id, [play(0)])).status).equals(200)
    const first = await read(id)
    const target = tagTargets(first.plays[0].gumbo)[0].id
    await db
      .insertInto('event_tag_catalog')
      .values({ tag: 'kept' })
      .onConflict(oc => oc.column('tag').doNothing())
      .execute()
    await db
      .insertInto('event_tags')
      .values([
        // Where the target is not, and a target that is gone.
        {
          game_id: id,
          target_id: target,
          at_bat_index: 7,
          event_index: 7,
          tag: 'kept',
          assigned_by: userIdOfGumbo(admin.userId)
        },
        {
          game_id: id,
          target_id: 'tag_gone',
          at_bat_index: 0,
          event_index: 0,
          tag: 'kept',
          assigned_by: userIdOfGumbo(admin.userId)
        }
      ])
      .execute()
    expect(await eventTagsNeedRepair(db, id)).equals(true)
    const moved = await read(id)
    expect(moved.status).equals(200)
    expect(
      (
        await db
          .selectFrom('event_tags')
          .select(['target_id', 'at_bat_index'])
          .where('game_id', '=', id)
          .execute()
      ).map(row => row.target_id)
    ).deep.equals([target])
    expect(await eventTagsNeedRepair(db, id)).equals(false)

    await db.deleteFrom('event_tags').where('game_id', '=', id).execute()
    await stripTags(id)
    const reads = await Promise.all(
      Array.from({ length: 6 }, async () => await read(id))
    )
    // Every reader shows the one set of identities that was stored.
    const stored = await db
      .selectFrom('events')
      .select('gumbo')
      .where('gameId', '=', id)
      .executeTakeFirstOrThrow()
    const ids = tagTargets(stored.gumbo as TagDocument).map(each => each.id)
    expect(ids.length).greaterThan(0)
    for (const each of reads) {
      expect(each.status).equals(200)
      expect(tagTargets(each.plays[0].gumbo).map(one => one.id)).deep.equals(
        ids
      )
    }
    expect(await eventTagsNeedRepair(db, id)).equals(false)
  })

  it('waits for an open post before it repairs, and answers what the post left', async function () {
    const id = await newGame('gam_read_repair_waits')
    expect((await post(id, [play(0)])).status).equals(200)
    await stripTags(id)
    let reading: Promise<Read> | undefined
    await duringOpenPost(id, [play(1)], async () => {
      reading = read(id)
      const early = await Promise.race([
        reading.then(() => 'answered'),
        new Promise(resolve =>
          setTimeout(() => {
            resolve('waiting')
          }, 300)
        )
      ])
      expect(early).equals('waiting')
    })
    const answer = await atOnce(reading!)
    expect(answer.status).equals(200)
    expect(answer.plays.length).equals(2)
    expect(await eventTagsNeedRepair(db, id)).equals(false)
  })

  it('reads under the lock when a repair will not hold, and still answers', async function () {
    const id = await newGame('gam_read_no_hold')
    expect((await post(id, [play(0)])).status).equals(200)
    await sql`create function keep_stripped() returns trigger language plpgsql as $$
      begin new.gumbo := new.gumbo - 'tagTargets'; return new; end $$`.execute(
      db
    )
    await sql
      .raw(
        `create trigger keep_stripped before update on events
      for each row when (new."gameId" = '${id}') execute function keep_stripped()`
      )
      .execute(db)
    try {
      await stripTags(id)
      const answer = await atOnce(read(id))
      expect(answer.status).equals(200)
      expect(answer.plays.length).equals(1)
      expect(answer.revision).equals(await readSyncClock(db))
    } finally {
      await sql`drop trigger keep_stripped on events`.execute(db)
      await sql`drop function keep_stripped()`.execute(db)
    }
  })
})
