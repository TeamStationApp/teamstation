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

  it('hears a channel in order, and only that channel', async function () {
    const { feed, prefix } = feedOf()
    const games = hearer()
    const chats = hearer()
    await Promise.all([
      feed.subscribe('game_changes', games).listening,
      feed.subscribe('chat_changes', chats).listening
    ])
    expect(games.listenings).deep.equals([true])
    const sent = Array.from({ length: 50 }, (_, index) => String(index))
    for (const payload of sent)
      await redis.publish(feedChannelKey(prefix, 'game_changes'), payload)
    await redis.publish(feedChannelKey(prefix, 'chat_changes'), 'hello')
    await until(
      () => games.payloads.length === 50 && chats.payloads.length === 1,
      'every payload'
    )
    expect(games.payloads).deep.equals(sent)
    expect(chats.payloads).deep.equals(['hello'])
  })

  it('tells a late handler it is first, and lets one handler go', async function () {
    const { feed, prefix } = feedOf()
    const early = hearer()
    const stopped = hearer()
    const { stop } = feed.subscribe('game_changes', stopped)
    await feed.subscribe('game_changes', early).listening
    const late = hearer()
    await feed.subscribe('game_changes', late).listening
    expect(late.listenings).deep.equals([true])
    stop()
    await redis.publish(feedChannelKey(prefix, 'game_changes'), 'x')
    await until(() => late.payloads.length === 1, 'the payload')
    expect(stopped.payloads).deep.equals([])
    expect(early.payloads).deep.equals(['x'])
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

  it('settles when a first attempt fails, says false for it, and true to one who came during the outage', async function () {
    const door = await redisDoor(false)
    const { feed } = feedOf({ url: door.url })
    const early = hearer()
    const subscription = feed.subscribe('game_changes', early)
    await subscription.listening
    expect(early.listenings).deep.equals([])
    const during = hearer()
    feed.subscribe('game_changes', during)
    await door.open()
    await until(() => during.listenings.length === 1, 'the connection')
    expect(early.listenings).deep.equals([false])
    expect(during.listenings).deep.equals([true])
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

  it('keeps one failing handler from the others', async function () {
    const { feed, prefix } = feedOf()
    const good = hearer()
    feed.subscribe('game_changes', {
      onPayload: () => {
        throw new Error('boom')
      }
    })
    await feed.subscribe('game_changes', good).listening
    await redis.publish(feedChannelKey(prefix, 'game_changes'), 'x')
    await until(() => good.payloads.length === 1, 'the payload')
    expect(lines.some(line => line.includes('boom'))).equals(true)
  })

  it('answers a subscription after it closed, and lets its handlers go on closing', async function () {
    const { feed } = feedOf()
    const waiting = feed.subscribe('game_changes', hearer())
    await feed.close()
    await waiting.listening
    const late = feed.subscribe('game_changes', hearer())
    await late.listening
    late.stop()
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
