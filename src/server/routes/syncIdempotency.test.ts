import { isDeepStrictEqual } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  asGameLineupsResponse,
  asRosterEntry,
  type SaveLineupsBody
} from '../../common/api'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { seedSettingsCleanup3 } from '../../test/settingsCleanup3Fixture'
import { KEY_RETENTION_DAYS, purgeExpiredKeys } from '../db/syncIdempotency'
import { readSyncClock } from '../socket/syncRevision'
import { startingContext } from './lineups'

/** A play the game takes from anybody who may score it. */
const livePlay = (atBatIndex: number, homeScore = 0): unknown => ({
  about: {
    atBatIndex,
    inning: 1,
    halfInning: 'top',
    isScoringPlay: homeScore > 0
  },
  count: { outs: 1 },
  result: {
    eventType: 'single',
    awayScore: 0,
    homeScore,
    description: 'Single'
  },
  playEvents: [{ isPitch: true }]
})

const livePost = (atBatIndex: number, homeScore = 0): unknown => ({
  mode: 'live',
  source: { system: 'manual' },
  plays: [livePlay(atBatIndex, homeScore)]
})

const newPlayer = {
  firstName: 'Mookie',
  lastName: 'Betts',
  jersey: '50',
  positions: ['RF'],
  bats: 'right',
  throws: 'right'
}

interface Sent {
  status: number
  body: unknown
}

/** One request, with an `Idempotency-Key` when `key` is set. */
async function send(
  f: GroupFixture,
  path: string,
  body: unknown,
  key?: string,
  user = 101
): Promise<Sent> {
  const response = await fetch(`${f.h.origin}/api/v1${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${f.h.tokens.get(user)!}`,
      'content-type': 'application/json',
      ...(key == null ? {} : { 'idempotency-key': key })
    },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

async function playCount(f: GroupFixture, gameId: string): Promise<number> {
  const row = await f.h.db
    .selectFrom('events')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .where('gameId', '=', gameId)
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

async function playersNamed(
  f: GroupFixture,
  teamId: string,
  firstName: string
): Promise<string[]> {
  const rows = await f.h.db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select('users.id')
    .where('memberships.team_id', '=', teamId)
    .where('users.first_name', '=', firstName)
    .execute()
  return rows.map(row => row.id)
}

async function insertGame(f: GroupFixture): Promise<string> {
  const gameId = makeId('game')
  await f.h.db
    .insertInto('games')
    .values({
      id: gameId,
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      season_id: f.seasonA,
      start_at: new Date(Date.now() + 3_600_000)
    })
    .execute()
  return gameId
}

/** The home side's lineup as the game opens on it, ready to save. */
async function homeLineup(
  f: GroupFixture,
  gameId: string
): Promise<SaveLineupsBody> {
  const context = await startingContext(
    f.h.db,
    gameId,
    { home_team_id: f.teamA, away_team_id: f.teamB },
    () => true
  )
  const setup = context.setup
  const side = setup.sides.home
  const index = (id: number): number => side.players.indexOf(id)
  const read = asGameLineupsResponse(
    await (
      await f.h.request('GET', `/games/${gameId}/lineups`, undefined, 101)
    ).json()
  )
  return {
    side: 'home',
    base: read.digest,
    players: side.players.map(id => ({
      gumboId: setup.players[id].id,
      fullName: setup.players[id].fullName,
      jersey: setup.players[id].jersey
    })),
    battingOrder: side.battingOrder.map(index),
    defense: Object.fromEntries(
      Object.entries(side.defense)
        .filter(([, id]) => id != null)
        .map(([position, id]) => [position, index(id!)])
    )
  }
}

describe('Idempotency-Key on the writes a phone queues', function () {
  this.timeout(60000)
  let f: GroupFixture

  before(async () => {
    f = await groupFixture()
    await seedSettingsCleanup3(f)
  })
  after(async () => {
    await f?.h.close()
  })

  it('answers a repeated live post as the first, and stores one play (Idempotent replay)', async function () {
    const gameId = await insertGame(f)
    const first = await send(f, `/games/${gameId}/events`, livePost(0), 'k-1')
    expect(first.status).equals(200)
    const again = await send(f, `/games/${gameId}/events`, livePost(0), 'k-1')
    expect(again).deep.equals(first)
    expect(await playCount(f, gameId)).equals(1)
    // The key is the sender's own: another person's same key is another post.
    const theirs = await send(
      f,
      `/games/${gameId}/events`,
      livePost(1),
      'k-1',
      102
    )
    expect(theirs.status).not.equals(409)
  })

  it('refuses the same key with another body, and writes nothing (Key mismatch)', async function () {
    const gameId = await insertGame(f)
    expect(
      (await send(f, `/games/${gameId}/events`, livePost(0), 'k-2')).status
    ).equals(200)
    const refused = await send(f, `/games/${gameId}/events`, livePost(1), 'k-2')
    expect(refused).deep.equals({
      status: 409,
      // Its own code, apart from a refusal of the change itself.
      body: {
        code: 'idempotencyKeyReused',
        message: 'This Idempotency-Key was already sent with another request'
      }
    })
    expect(await playCount(f, gameId)).equals(1)
    // Nor may it name a player on a roster.
    const made = await send(
      f,
      `/teams/${f.teamA}/roster-players`,
      { ...newPlayer, firstName: 'Salvador' },
      'k-2'
    )
    expect(made.status).equals(409)
    expect(made.body).property('code').equals('idempotencyKeyReused')
    expect(await playersNamed(f, f.teamA, 'Salvador')).deep.equals([])
  })

  it('writes every post that names no key, as today (Absent key)', async function () {
    const gameId = await insertGame(f)
    expect(
      (await send(f, `/games/${gameId}/events`, livePost(0))).status
    ).equals(200)
    expect(
      (await send(f, `/games/${gameId}/events`, livePost(1))).status
    ).equals(200)
    expect(await playCount(f, gameId)).equals(2)
    // The same body again, with no key, is a second post.
    expect(
      (await send(f, `/games/${gameId}/events`, livePost(1, 1))).status
    ).equals(200)
    const rows = await f.h.db
      .selectFrom('sync_idempotency')
      .select('key')
      .where('path', 'like', `%${gameId}%`)
      .execute()
    expect(rows).deep.equals([])
    // A replace post keeps no key either.
    const replaced = await send(
      f,
      `/games/${gameId}/events`,
      { source: { system: 'manual' }, plays: [livePlay(0)] },
      'k-replace'
    )
    expect(replaced.status).equals(200)
    expect(
      await f.h.db
        .selectFrom('sync_idempotency')
        .select('key')
        .where('key', '=', 'k-replace')
        .execute()
    ).deep.equals([])
  })

  it('refuses a key that is empty or too long', async function () {
    const gameId = await insertGame(f)
    for (const key of [' ', 'x'.repeat(201), 'naïve'])
      expect(
        (await send(f, `/games/${gameId}/events`, livePost(0), key)).status
      ).equals(400)
    expect(await playCount(f, gameId)).equals(0)
  })

  it('makes one player for a repeated create, and rebuilds an answer the server never stored (Lost response)', async function () {
    const path = `/teams/${f.teamA}/roster-players`
    const body = { ...newPlayer, firstName: 'Bobby' }
    const first = await send(f, path, body, 'k-roster')
    expect(first.status).equals(201)
    const entry = asRosterEntry(first.body)
    const again = await send(f, path, body, 'k-roster')
    expect(again).deep.equals(first)
    expect(await playersNamed(f, f.teamA, 'Bobby')).deep.equals([entry.userId])
    // The process stopped after the player committed and before its answer
    // was stored: the key holds his id and nothing else.
    const held = await f.h.db
      .selectFrom('sync_idempotency')
      .select(['result_id', 'status', 'method', 'path'])
      .where('key', '=', 'k-roster')
      .executeTakeFirstOrThrow()
    expect(held).deep.equals({
      result_id: entry.userId,
      status: 201,
      method: 'POST',
      path: `/api/v1${path}`
    })
    await f.h.db
      .updateTable('sync_idempotency')
      .set({ status: null, body: null })
      .where('key', '=', 'k-roster')
      .execute()
    const rebuilt = await send(f, path, body, 'k-roster')
    expect(rebuilt).deep.equals(first)
    expect(await playersNamed(f, f.teamA, 'Bobby')).deep.equals([entry.userId])
    const stored = await f.h.db
      .selectFrom('sync_idempotency')
      .select(['status', 'body'])
      .where('key', '=', 'k-roster')
      .executeTakeFirstOrThrow()
    expect(stored).deep.equals({ status: 201, body: first.body })
  })

  it('saves a lineup once for a repeated save, and rebuilds its answer from the digest it kept', async function () {
    const gameId = 'gam_settings3_scheduled'
    const body = await homeLineup(f, gameId)
    // Batting order reversed, so the save has something to write.
    body.battingOrder = [...body.battingOrder].reverse()
    // Each save that writes takes the next revision of the clock.
    const saves = async (): Promise<number> =>
      Number(await readSyncClock(f.h.db))
    const before = await saves()
    const first = await send(f, `/games/${gameId}/lineups`, body, 'k-lineup')
    expect(first.status, JSON.stringify(first.body)).equals(200)
    const digest = (first.body as { digest: string }).digest
    const after = await saves()
    expect(after).greaterThan(before)
    expect(
      await send(f, `/games/${gameId}/lineups`, body, 'k-lineup')
    ).deep.equals(first)
    expect(await saves()).equals(after)
    const held = await f.h.db
      .selectFrom('sync_idempotency')
      .select('result_id')
      .where('key', '=', 'k-lineup')
      .executeTakeFirstOrThrow()
    expect(held.result_id).equals(digest)
    await f.h.db
      .updateTable('sync_idempotency')
      .set({ status: null, body: null })
      .where('key', '=', 'k-lineup')
      .execute()
    expect(
      await send(f, `/games/${gameId}/lineups`, body, 'k-lineup')
    ).deep.equals(first)
    expect(await saves()).equals(after)
    // A save with nothing to change still keeps its answer by its key.
    const unchanged = await send(
      f,
      `/games/${gameId}/lineups`,
      { ...body, base: digest },
      'k-unchanged'
    )
    expect(unchanged.status).equals(200)
    expect(
      await send(
        f,
        `/games/${gameId}/lineups`,
        { ...body, base: digest },
        'k-unchanged'
      )
    ).deep.equals(unchanged)
    expect(await saves()).equals(after)
  })

  it('keeps only a live post’s own digests, and rebuilds its answer from the game on replay', async function () {
    const gameId = await insertGame(f)
    const path = `/games/${gameId}/events`
    const first = await send(f, path, livePost(0), 'k-live')
    expect(first.status).equals(200)
    const answered = first.body as {
      priorPlaysDigest: string | null
      lineupsDigest: string | null
      playsDigest: string
    }
    const row = async (): Promise<Record<string, unknown>> =>
      await f.h.db
        .selectFrom('sync_idempotency')
        .select(['status', 'body', 'result_id'])
        .where('key', '=', 'k-live')
        .executeTakeFirstOrThrow()
    // Not every play of the game: the status and the post's two digests.
    expect(await row()).deep.equals({
      status: 200,
      body: null,
      result_id: JSON.stringify({
        priorPlaysDigest: answered.priorPlaysDigest,
        lineupsDigest: answered.lineupsDigest
      })
    })
    // Sent again at once, the answer is the first one.
    expect(await send(f, path, livePost(0), 'k-live')).deep.equals(first)
    // After another post, it is the game as it stands, with this post's
    // digests: the queue's next post is still checked against them.
    expect((await send(f, path, livePost(1))).status).equals(200)
    const again = await send(f, path, livePost(0), 'k-live')
    const read = (await (
      await f.h.request('GET', path, undefined, 101)
    ).json()) as { playsDigest: string; plays: unknown[] }
    expect(again.status).equals(200)
    expect(again.body).deep.include({
      priorPlaysDigest: answered.priorPlaysDigest,
      lineupsDigest: answered.lineupsDigest,
      playsDigest: read.playsDigest
    })
    expect((again.body as { plays: unknown[] }).plays).deep.equals(read.plays)
    expect(await playCount(f, gameId)).equals(2)
    expect((await row()).body).equals(null)
  })

  it('keeps keys KEY_RETENTION_DAYS, deleting them on the sweep and never on a request', async function () {
    const gameId = await insertGame(f)
    const day = 24 * 60 * 60 * 1000
    const claimed = (user: number, key: string, daysAgo: number): unknown => ({
      user_id: userIdOfGumbo(user),
      key,
      method: 'POST',
      path: '/api/v1/elsewhere',
      request_hash: 'another-request',
      status: 200,
      body: '{}',
      created_at: new Date(Date.now() - daysAgo * day)
    })
    await f.h.db
      .insertInto('sync_idempotency')
      .values([
        claimed(101, 'k-expired', KEY_RETENTION_DAYS + 1),
        claimed(101, 'k-kept', KEY_RETENTION_DAYS - 1),
        claimed(102, 'k-theirs', KEY_RETENTION_DAYS + 1)
      ] as never)
      .execute()
    const keys = async (): Promise<string[]> =>
      (
        await f.h.db
          .selectFrom('sync_idempotency')
          .select('key')
          .where('key', 'in', ['k-expired', 'k-kept', 'k-theirs'])
          .orderBy('key')
          .execute()
      ).map(row => row.key)
    const post = async (key: string): Promise<Sent> =>
      await send(f, `/games/${gameId}/events`, livePost(0), key)
    // A keyed request deletes nothing: until the sweep, an expired key is
    // still held.
    expect((await post('k-expired')).status).equals(409)
    expect(await keys()).deep.equals(['k-expired', 'k-kept', 'k-theirs'])
    // The sweep takes everybody's expired keys, and only those.
    expect(await purgeExpiredKeys(f.h.db)).equals(2)
    expect(await keys()).deep.equals(['k-kept'])
    expect(await purgeExpiredKeys(f.h.db)).equals(0)
    // Swept, the key is no longer held: sent again, it is a new post. A
    // kept one is still held.
    expect((await post('k-expired')).status).equals(200)
    expect(await playCount(f, gameId)).equals(1)
    expect((await post('k-kept')).status).equals(409)
    // Ninety days on, the sweep takes every key there is.
    expect(
      await purgeExpiredKeys(
        f.h.db,
        new Date(Date.now() + (KEY_RETENTION_DAYS + 1) * day)
      )
    ).greaterThan(0)
    expect(
      await f.h.db.selectFrom('sync_idempotency').select('key').execute()
    ).deep.equals([])
  })

  it('answers two posts sent at once with one key as one, and stores one play', async function () {
    const gameId = await insertGame(f)
    const [one, two] = await Promise.all([
      send(f, `/games/${gameId}/events`, livePost(0), 'k-race'),
      send(f, `/games/${gameId}/events`, livePost(0), 'k-race')
    ])
    expect(one.status).equals(200)
    expect(two).deep.equals(one)
    expect(await playCount(f, gameId)).equals(1)
  })
})

describe('S4: a live play posted twice with one key is stored once', function () {
  this.timeout(60000)
  let f: GroupFixture
  let started = 0
  const note = (line: string): void => {
    console.log(`      ${String(Date.now() - started).padStart(5)}ms ${line}`)
  }

  before(async () => {
    f = await groupFixture()
    started = Date.now()
  })
  after(async () => {
    await f?.h.close()
  })

  it('stores one play, and answers the second post as the first', async function () {
    const gameId = await insertGame(f)
    const path = `/games/${gameId}/events`
    note(`→ POST ${path.replace(gameId, ':gameId')} Idempotency-Key: s4-play`)
    const first = await send(f, path, livePost(0, 1), 's4-play')
    note(
      `← ${first.status} plays ${JSON.stringify(
        (first.body as { plays: unknown[] }).plays.length
      )}, playsDigest ${(first.body as { playsDigest: string }).playsDigest.slice(0, 12)}…`
    )
    note(
      `→ POST ${path.replace(gameId, ':gameId')} Idempotency-Key: s4-play (again)`
    )
    const second = await send(f, path, livePost(0, 1), 's4-play')
    note(
      `← ${second.status} plays ${JSON.stringify(
        (second.body as { plays: unknown[] }).plays.length
      )}, playsDigest ${(second.body as { playsDigest: string }).playsDigest.slice(0, 12)}…`
    )
    const same = isDeepStrictEqual(second.body, first.body)
    note(`  the second answer equals the first: ${same}`)
    expect(second).deep.equals(first)
    const stored = await playCount(f, gameId)
    note(`  plays stored for the game: ${stored}`)
    expect(stored).equals(1)
    const keys = await f.h.db
      .selectFrom('sync_idempotency')
      .select(['key', 'status'])
      .where('key', '=', 's4-play')
      .execute()
    note(`  sync_idempotency rows for the key: ${JSON.stringify(keys)}`)
    expect(keys).deep.equals([{ key: 's4-play', status: 200 }])
  })
})
