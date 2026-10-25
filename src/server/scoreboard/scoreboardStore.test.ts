import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  NO_OVERRIDES,
  scoreboardExpiry,
  type ScoreboardUpdate
} from '../../common/scoreboard'
import {
  dropPrefix,
  requireRedis,
  testPrefix,
  testStore
} from '../../test/scoreboardKit'
import {
  makeScoreboardClient,
  makeScoreboardSubscriber,
  parseScoreboardMessage,
  quit,
  redisSocketOptions,
  type ScoreboardClient,
  type ScoreboardMessage,
  scoreboardPrefix,
  type ScoreboardStore,
  watcherMode,
  type WriteResult
} from './scoreboardStore'

/**
 * `WRITE_SCOREBOARD` against a real Redis (`TS_TEST_REDIS_URL`), each test
 * under a prefix of its own and with a clock it moves by hand.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

function written(result: WriteResult): ScoreboardMessage {
  if (result.kind !== 'written') throw new Error(`not written: ${result.kind}`)
  return result.message
}

describe('the scoreboard store', function () {
  this.timeout(20000)

  // The start is now, so every expiry the script sets is in Redis's future.
  let S = 0
  let clock = 0
  let prefix = ''
  let client: ScoreboardClient
  let store: ScoreboardStore
  let subscriber: ScoreboardClient
  let heard: string[] = []
  const opened: ScoreboardClient[] = []

  before(async function () {
    await requireRedis()
  })

  beforeEach(async function () {
    prefix = testPrefix()
    S = Math.floor(Date.now() / 1000) * 1000
    clock = S
    ;({ client, store } = await testStore(prefix, () => clock))
    subscriber = makeScoreboardSubscriber(client, () => undefined)
    await subscriber.connect()
    heard = []
    await subscriber.subscribe(store.channel, message => {
      heard.push(message)
    })
    opened.push(client, subscriber)
  })

  after(async function () {
    for (const one of opened) if (one.isOpen) await one.close()
    await dropPrefix('ts-test')
  })

  /** Every message published so far, once they have all arrived. */
  async function messages(count: number): Promise<ScoreboardMessage[]> {
    const deadline = Date.now() + 3000
    while (heard.length < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    // Long enough for a stray extra message to show up too.
    await new Promise(resolve => setTimeout(resolve, 50))
    return heard.map(parseScoreboardMessage)
  }

  it('replaces and merges, stamping each source and the key', async function () {
    const game = written(
      await store.writeGame('g1', { balls: 1, strikes: 2 }, S, 5)
    )
    expect(game.game).deep.equals({
      state: { balls: 1, strikes: 2 },
      receivedAt: S,
      sourceVersion: 5
    })
    clock = S + 1000
    written(await store.writeGame('g1', { outs: 1 }, S, 6))
    clock = S + 2000
    written(await store.mergeWatcher('g1', { balls: 3 }, S))
    clock = S + 3000
    const merged = written(
      await store.mergeWatcher('g1', { strikes: 1, pitchSpeed: 70 }, S)
    )
    // `replace` threw away the game's count; `merge` kept Watcher's balls.
    expect(merged.game?.state).deep.equals({ outs: 1 })
    expect(merged.watcher).deep.equals({
      state: { balls: 3, strikes: 1, pitchSpeed: 70 },
      receivedAt: S + 3000
    })
    expect(await client.hGet(store.keyOf('g1'), 'lastUpdate')).equals(
      String(S + 3000)
    )
    expect(await store.readScoreboard('g1')).deep.equals({
      gameId: 'g1',
      version: merged.version,
      game: merged.game,
      watcher: merged.watcher
    })
    expect(await store.readScoreboard('nothing')).equals(undefined)
    expect(await store.exists('g1')).equals(true)
    expect(await store.exists('nothing')).equals(false)
  })

  it('expires the key when scoreboardExpiry says', async function () {
    // One key written the day before, during, and at the very end: after
    // two hours with nothing written, a key is only kept alive by writes.
    for (const write of [S - DAY, S + HOUR, S + 2 * DAY + 23 * HOUR]) {
      clock = write
      written(await store.mergeWatcher('g1', { outs: 1 }, S))
      expect(await client.pExpireTime(store.keyOf('g1'))).equals(
        scoreboardExpiry(S, write)
      )
      if (write === S + HOUR) {
        expect(await client.pTTL(store.keyOf('g1'))).is.within(
          3 * HOUR - 5000,
          3 * HOUR
        )
      }
    }
    expect(await client.pExpireTime(store.keyOf('g1'))).equals(S + 3 * DAY)
  })

  it('publishes exactly one message per write, carrying the whole hash', async function () {
    written(await store.writeGame('g1', { balls: 1 }, S, 1))
    written(await store.mergeWatcher('g1', { pitchSpeed: 60 }, S))
    const last = written(
      await store.writeOverrides(
        'g1',
        {
          ...NO_OVERRIDES,
          overrideCountEnabled: true,
          overrideCount: { balls: 0, strikes: 2, outs: 0 }
        },
        S
      )
    )
    const got = await messages(3)
    expect(got).has.length(3)
    expect(got.map(one => one.field)).deep.equals([
      'game',
      'watcher',
      'overrides'
    ])
    expect(got[2]).deep.equals(last)
    expect(got[2].game?.state).deep.equals({ balls: 1 })
    expect(got[2].watcher?.state).deep.equals({ pitchSpeed: 60 })
    expect(got[2].overrides?.overrideCount).deep.equals({
      balls: 0,
      strikes: 2,
      outs: 0
    })
  })

  it('resets the overrides and deletes the watcher state in one write', async function () {
    clock = S + HOUR
    written(await store.writeGame('g1', { balls: 1 }, S, 1))
    written(await store.mergeWatcher('g1', { balls: 3 }, S))
    const overridden = written(
      await store.writeOverrides(
        'g1',
        { ...NO_OVERRIDES, overrideCountEnabled: true },
        S
      )
    )
    clock = S + 2 * HOUR
    const reset = written(await store.resetScoreboard('g1', S))
    const got = await messages(4)
    expect(got[3]).deep.equals(reset)
    expect(reset.field).equals('overrides')
    expect(reset.version).is.above(overridden.version)
    expect(reset.watcher).equals(undefined)
    expect(reset.overrides).deep.includes(NO_OVERRIDES)
    expect(reset.game?.state).deep.equals({ balls: 1 })
    expect(await client.hGet(store.keyOf('g1'), 'watcher')).equals(null)
    expect(await client.pExpireTime(store.keyOf('g1'))).equals(
      scoreboardExpiry(S, clock)
    )
    const hash = await store.readScoreboard('g1')
    expect(hash?.watcher).equals(undefined)
    expect(hash?.overrides).deep.includes(NO_OVERRIDES)
    clock = S + 3 * DAY
    expect(await store.resetScoreboard('g1', S)).deep.equals({
      kind: 'closed'
    })
  })

  it("clears the game's own scoring and keeps the rest, unless it holds none or a newer one (S10)", async function () {
    await store.writeGame('g1', { inning: 4, awayScore: 3 }, S, 5)
    await store.mergeWatcher('g1', { pitchSpeed: 81 }, S)
    expect(
      (await store.clearGame('g1', S, 4)).kind,
      'an older game write'
    ).equals('stale')
    expect((await store.readScoreboard('g1'))?.game?.state).deep.equals({
      inning: 4,
      awayScore: 3
    })
    heard = []
    const cleared = written(await store.clearGame('g1', S, 6))
    expect(cleared.game).equals(undefined)
    expect(cleared.watcher?.state).deep.equals({ pitchSpeed: 81 })
    const hash = await store.readScoreboard('g1')
    expect(hash?.game).equals(undefined)
    expect(hash?.watcher?.state).deep.equals({ pitchSpeed: 81 })
    expect(heard).has.length(1)
    expect((await store.clearGame('g1', S, 7)).kind).equals('closed')
    expect((await store.clearGame('g2', S, 1)).kind).equals('closed')
    expect(await store.exists('g2')).equals(false)
  })

  it('refuses to open a closed scoreboard, and writes nothing', async function () {
    clock = S + 2 * HOUR
    expect(await store.mergeWatcher('late', { outs: 1 }, S)).deep.equals({
      kind: 'closed'
    })
    expect(await store.exists('late')).equals(false)

    clock = S + HOUR
    written(await store.mergeWatcher('kept', { outs: 1 }, S))
    clock = S + 3 * DAY
    expect(await store.mergeWatcher('kept', { outs: 2 }, S)).deep.equals({
      kind: 'closed'
    })
    expect((await store.readScoreboard('kept'))?.watcher?.state).deep.equals({
      outs: 1
    })
    expect(await messages(1)).has.length(1)
  })

  it('lands two merges sent at once from two connections', async function () {
    const other = await testStore(prefix, () => clock)
    opened.push(other.client)
    await Promise.all([
      store.mergeWatcher('g1', { balls: 2 }, S),
      other.store.mergeWatcher('g1', { strikes: 1 }, S)
    ])
    expect((await store.readScoreboard('g1'))?.watcher?.state).deep.equals({
      balls: 2,
      strikes: 1
    })
  })

  it('never lets the version go backwards, even within one millisecond', async function () {
    const first = written(await store.mergeWatcher('g1', { balls: 0 }, S))
    expect(first.version).equals(S * 1000)
    // Two writes in the same millisecond: the second is one above.
    const second = written(await store.mergeWatcher('g1', { balls: 1 }, S))
    expect(second.version).equals(S * 1000 + 1)
    clock = S + 1
    const third = written(await store.mergeWatcher('g1', { balls: 2 }, S))
    expect(third.version).equals((S + 1) * 1000)
    // A snapshot from before, with a lower count, is still overtaken.
    await client.hSet(store.keyOf('g1'), 'version', '5')
    clock = S + 2
    const restored = written(await store.mergeWatcher('g1', { balls: 3 }, S))
    expect(restored.version).equals((S + 2) * 1000)
    // A key that expired and came back starts above the old one.
    await client.del(store.keyOf('g1'))
    clock = S + 3
    const again = written(await store.mergeWatcher('g1', { balls: 0 }, S))
    expect(again.version).is.above(restored.version)
    const versions = (await messages(5)).map(one => one.version)
    expect(versions).deep.equals([
      S * 1000,
      S * 1000 + 1,
      (S + 1) * 1000,
      (S + 2) * 1000,
      (S + 3) * 1000
    ])
    expect(new Set(versions.slice(0, 3)).size).equals(3)
  })

  it('answers stale for an older game, and changes nothing', async function () {
    written(await store.writeGame('g1', { balls: 2 }, S, 2_000_000))
    expect(await store.writeGame('g1', { balls: 1 }, S, 1_000_000)).deep.equals(
      { kind: 'stale' }
    )
    expect((await store.readScoreboard('g1'))?.game).deep.equals({
      state: { balls: 2 },
      receivedAt: S,
      sourceVersion: 2_000_000
    })
    // An equal version is the same game read twice, which may be written.
    written(await store.writeGame('g1', { balls: 3 }, S, 2_000_000))
  })

  it('merges a TagOne-only packet without making Watcher newer', async function () {
    expect(watcherMode({ pitchSpeed: 71 })).equals('mergeUncontested')
    expect(watcherMode({ balls: 1, pitchSpeed: 71 })).equals('merge')
    // Before Watcher has contested anything, it counts as oldest.
    const alone = written(await store.mergeWatcher('g1', { pitchSpeed: 50 }, S))
    expect(alone.watcher?.receivedAt).equals(0)
    clock = S + 10
    written(await store.mergeWatcher('g1', { balls: 1 }, S))
    clock = S + 20
    const tagOne = written(
      await store.mergeWatcher('g1', { pitchSpeed: 71 }, S)
    )
    expect(tagOne.watcher).deep.equals({
      state: { balls: 1, pitchSpeed: 71 },
      receivedAt: S + 10
    })
  })

  it('never stores a team name from Watcher', async function () {
    const update: ScoreboardUpdate = {
      homeTeam: 'WRONG',
      awayTeam: 'WRONG',
      outs: 2
    }
    const message = written(await store.mergeWatcher('g1', update, S))
    expect(message.watcher?.state).deep.equals({ outs: 2 })
  })

  it('writes through EVAL after the script cache is flushed', async function () {
    written(await store.mergeWatcher('g1', { balls: 1 }, S))
    await client.scriptFlush()
    const after = written(await store.mergeWatcher('g1', { strikes: 1 }, S))
    expect(after.watcher?.state).deep.equals({ balls: 1, strikes: 1 })
  })

  it('names its keys after the database unless told a prefix', function () {
    expect(
      scoreboardPrefix('', 'postgres://localhost:5433/AppDatabase_seat')
    ).equals('ts:AppDatabase_seat')
    expect(scoreboardPrefix('mine', 'postgres://x/y')).equals('mine')
    expect(() => parseScoreboardMessage('{"gameId":1}')).throws(TypeError)
    expect(() =>
      parseScoreboardMessage(
        '{"gameId":"g","version":"1.5","field":"game","game":null,"watcher":null,"overrides":null}'
      )
    ).throws(TypeError)
  })

  it('closes its connection, and closing twice is harmless', async function () {
    const { store: closing } = await testStore(prefix)
    await closing.close()
    await closing.close()
    expect(closing.isReady()).equals(false)
    // One still trying to reach a Redis that is not there closes at once.
    const stuck = makeScoreboardClient('redis://127.0.0.1:1', () => undefined)
    const connecting = stuck.connect().catch(() => undefined)
    expect(stuck.isOpen).equals(true)
    await quit(stuck)
    expect(stuck.isOpen).equals(false)
    await connecting
  })
})

describe('the Redis connection options', function () {
  it('adds nothing for a local Redis, whose URL says it all', function () {
    expect(redisSocketOptions('')).equals(undefined)
  })

  it('checks TLS against the CA file when one is named', function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-redis-ca-'))
    try {
      const file = join(dir, 'ca.crt')
      writeFileSync(file, '-----BEGIN CERTIFICATE-----\nAAAA\n')
      expect(redisSocketOptions(file)).deep.equals({
        tls: true,
        ca: '-----BEGIN CERTIFICATE-----\nAAAA\n'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to start with a CA file it cannot read, and names it', function () {
    expect(() => redisSocketOptions('/nowhere/ca.crt')).throws(
      /redis\.caFile \/nowhere\/ca\.crt cannot be read/
    )
  })

  it('builds a client carrying the CA, and one without when there is none', function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-redis-ca-'))
    try {
      const file = join(dir, 'ca.crt')
      writeFileSync(file, 'CA')
      const withCa = makeScoreboardClient(
        'rediss://localhost:1',
        () => {},
        'test',
        file
      )
      expect(withCa.options?.socket).deep.include({ tls: true, ca: 'CA' })
      const plain = makeScoreboardClient('redis://localhost:1', () => {})
      expect(plain.options?.socket?.tls).not.equals(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
