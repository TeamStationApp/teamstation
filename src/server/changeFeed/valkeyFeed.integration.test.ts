import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { createClient } from 'redis'

import {
  quiet,
  requireRedis,
  testPrefix,
  testRedisUrl
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { asServerConfig } from '../serverConfig'
import { notifyTyping } from '../socket/chatFanout'
import type { ChangeFeed } from './feed'
import { hearer, redisDoor, until, wait } from './feedTestKit'
import { makeChangeFeed } from './makeChangeFeed'
import { PostgresFeed } from './postgresFeed'
import {
  feedChannelKey,
  feedControlKey,
  ValkeyFeed,
  type ValkeyFeedOptions
} from './valkeyFeed'

const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('Postgres was touched')
    }
  }
) as Kysely<Database>

describe('the Valkey change feed', function () {
  this.timeout(20000)
  const feeds: ValkeyFeed[] = []
  const redis = createClient({ url: testRedisUrl })
  let lines: string[] = []

  const feedOf = (
    options: Partial<ValkeyFeedOptions> = {}
  ): { feed: ValkeyFeed; prefix: string } => {
    const prefix = options.prefix ?? testPrefix()
    lines = []
    const feed = new ValkeyFeed({
      url: testRedisUrl,
      log: line => lines.push(line),
      ...options,
      prefix
    })
    feeds.push(feed)
    return { feed, prefix }
  }
  const control = async (prefix: string, kind: string): Promise<void> => {
    await redis.publish(feedControlKey(prefix), JSON.stringify({ kind }))
  }

  before(async function () {
    await requireRedis()
    redis.on('error', quiet)
    await redis.connect()
  })

  after(async function () {
    for (const feed of feeds) await feed.close()
    await redis.close()
  })

  it('counts a control resync as a gap, once per handler', async function () {
    const { feed, prefix } = feedOf()
    const games = hearer()
    const screens = hearer()
    await Promise.all([
      feed.subscribe('game_changes', games).listening,
      feed.subscribe('screen_scopes', screens).listening
    ])
    await control(prefix, 'resync')
    await until(() => screens.listenings.length === 2, 'the resync')
    expect(games.listenings).deep.equals([true, false])
    expect(screens.listenings).deep.equals([true, false])
    // A beat straight after it is no silence.
    await control(prefix, 'heartbeat')
    await wait(50)
    expect(games.listenings).deep.equals([true, false])
  })

  it('fires once when a heartbeat resumes after a silence, and not while it keeps coming', async function () {
    const { feed, prefix } = feedOf({ silenceMs: 150 })
    const games = hearer()
    await feed.subscribe('game_changes', games).listening
    await control(prefix, 'heartbeat')
    await wait(30)
    await control(prefix, 'heartbeat')
    await wait(30)
    expect(games.listenings).deep.equals([true])
    await wait(200)
    expect(games.listenings).deep.equals([true])
    await control(prefix, 'heartbeat')
    await control(prefix, 'heartbeat')
    await until(() => games.listenings.length === 2, 'the gap')
    await wait(30)
    expect(games.listenings).deep.equals([true, false])
  })

  it('ignores a control message it cannot read', async function () {
    const { feed, prefix } = feedOf()
    const games = hearer()
    await feed.subscribe('game_changes', games).listening
    await redis.publish(feedControlKey(prefix), 'not json')
    await until(
      () => lines.some(line => line.includes('unreadable')),
      'the complaint'
    )
    expect(games.listenings).deep.equals([true])
  })

  it('counts a subscriber reconnect as a gap, and hears again after it', async function () {
    const door = await redisDoor()
    const { feed, prefix } = feedOf({ url: door.url, silenceMs: 100 })
    const games = hearer()
    await feed.subscribe('game_changes', games).listening
    await control(prefix, 'heartbeat')
    await wait(30)
    await door.shut()
    await wait(200)
    expect(games.listenings).deep.equals([true])
    await door.open()
    await until(() => games.listenings.length === 2, 'the return')
    expect(games.listenings).deep.equals([true, false])
    // The silence the outage made is already paid for.
    await control(prefix, 'heartbeat')
    await redis.publish(feedChannelKey(prefix, 'game_changes'), 'after')
    await until(() => games.payloads.length === 1, 'a payload after')
    expect(games.listenings).deep.equals([true, false])
    await feed.close()
    await door.shut()
  })

  it('hears a resync once per handler however many times it reconnected', async function () {
    const door = await redisDoor()
    const { feed, prefix } = feedOf({ url: door.url })
    const games = hearer()
    const screens = hearer()
    await Promise.all([
      feed.subscribe('game_changes', games).listening,
      feed.subscribe('screen_scopes', screens).listening
    ])
    for (const returns of [2, 3]) {
      await door.shut()
      await wait(100)
      await door.open()
      await until(() => games.listenings.length === returns, 'the return')
      await until(() => screens.listenings.length === returns, 'the return')
    }
    await control(prefix, 'resync')
    await until(() => games.listenings.length === 4, 'the resync')
    await wait(100)
    expect(games.listenings).deep.equals([true, false, false, false])
    expect(screens.listenings).deep.equals([true, false, false, false])
    await feed.close()
    await door.shut()
  })

  it('publishes straight to Valkey, connecting on first use and never touching Postgres', async function () {
    const { feed, prefix } = feedOf()
    const chats = hearer()
    await feed.subscribe('chat_changes', chats).listening
    const other = new ValkeyFeed({ url: testRedisUrl, prefix, log: quiet })
    feeds.push(other)
    await (other as ChangeFeed).publishEphemeral(
      'chat_changes',
      'typing',
      untouchable
    )
    await other.publishEphemeral('chat_changes', 'again')
    await until(() => chats.payloads.length === 2, 'the hints')
    expect(chats.payloads).deep.equals(['typing', 'again'])
    expect(await other.leader()).equals(null)
  })

  it('carries a typing hint without Postgres, as the chat fan-out sends it', async function () {
    const { feed } = feedOf()
    const chats = hearer()
    await feed.subscribe('chat_changes', chats).listening
    await notifyTyping(feed, untouchable, 'cnv_a', 'usr_b')
    await until(() => chats.payloads.length === 1, 'the hint')
    expect(JSON.parse(chats.payloads[0] ?? '')).deep.equals({
      c: 'cnv_a',
      k: 'typing',
      u: 'usr_b'
    })
  })

  it('refuses a publish rather than waiting when Valkey is away', async function () {
    const door = await redisDoor(false)
    const { feed } = feedOf({ url: door.url, connectWaitMs: 50 })
    let refused = false
    await feed.publishEphemeral('chat_changes', 'typing').catch(() => {
      refused = true
    })
    expect(refused).equals(true)
    await feed.close()
  })

  it('is what a process gets from its config, which defaults to Postgres', async function () {
    const base = {
      databaseUrl: 'postgres://db.example.test/teamstation',
      redis: { url: testRedisUrl, prefix: testPrefix(), caFile: '' }
    }
    expect(asServerConfig({}).changeFeed).equals('postgres')
    expect(asServerConfig({ changeFeed: 'valkey' }).changeFeed).equals('valkey')
    expect(() => asServerConfig({ changeFeed: 'carrier pigeon' })).throws()
    const valkey = makeChangeFeed({ ...base, changeFeed: 'valkey' }, quiet)
    expect(valkey).instanceOf(ValkeyFeed)
    await valkey.close()
    const postgres = makeChangeFeed({ ...base, changeFeed: 'postgres' }, quiet)
    expect(postgres).instanceOf(PostgresFeed)
    await postgres.close()
  })
})
