import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import { createClient } from 'redis'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import {
  quiet,
  requireRedis,
  testPrefix,
  testRedisUrl
} from '../../test/scoreboardKit'
import type { ChangeFeed, FeedChannel } from './feed'
import { hearer, redisDoor, until, wait } from './feedTestKit'
import { FEED_APPLICATION_NAME, PostgresFeed } from './postgresFeed'
import { feedChannelKey, ValkeyFeed } from './valkeyFeed'

/** A feed on its transport, with what a case needs to do to that transport. */
interface FeedUnderTest {
  feed: ChangeFeed
  notify: (channel: FeedChannel, payload: string) => Promise<void>
  /** Takes the connection away, runs `during` once the feed has lost it, and lets it come back. */
  outage: (during?: () => void) => Promise<void>
}

/** A feed whose first attempt fails, until `arrive`. */
interface LateFeed {
  feed: ChangeFeed
  arrive: () => Promise<void>
}

interface Transport {
  name: string
  before: () => Promise<void>
  after: () => Promise<void>
  fresh: (log: (line: string) => void) => Promise<FeedUnderTest>
  late: (log: (line: string) => void) => Promise<LateFeed>
}

function postgresTransport(): Transport {
  const stamp = `${Date.now()}_${process.pid}`
  const scratchName = `teamstation_contract_${stamp}`
  const lateNames: string[] = []
  const urlOf = (name: string): string =>
    testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  let admin: Pool
  let poker: Pool
  return {
    name: 'Postgres',
    before: async () => {
      admin = new Pool({ connectionString: testDatabaseUrl })
      await admin.query(`create database ${scratchName}`)
      poker = new Pool({ connectionString: urlOf(scratchName) })
    },
    after: async () => {
      await poker.end()
      for (const name of [scratchName, ...lateNames])
        await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
    },
    fresh: async log => {
      const lines: string[] = []
      const feed = new PostgresFeed({
        databaseUrl: urlOf(scratchName),
        retryMs: 200,
        log: line => {
          lines.push(line)
          log(line)
        }
      })
      return {
        feed,
        notify: async (channel, payload) => {
          await poker.query('select pg_notify($1, $2)', [channel, payload])
        },
        outage: async during => {
          const before = lines.length
          await admin.query(
            `select pg_terminate_backend(pid) from pg_stat_activity
             where datname = $1 and application_name = $2`,
            [scratchName, FEED_APPLICATION_NAME]
          )
          await until(() => lines.length > before, 'the loss')
          during?.()
        }
      }
    },
    late: async log => {
      const name = `teamstation_contract_late_${stamp}_${lateNames.length}`
      lateNames.push(name)
      return {
        feed: new PostgresFeed({
          databaseUrl: urlOf(name),
          retryMs: 30,
          log
        }),
        arrive: async () => {
          await admin.query(`create database ${name}`)
        }
      }
    }
  }
}

function valkeyTransport(): Transport {
  const redis = createClient({ url: testRedisUrl })
  const doors: Array<Awaited<ReturnType<typeof redisDoor>>> = []
  return {
    name: 'Valkey',
    before: async () => {
      await requireRedis()
      redis.on('error', quiet)
      await redis.connect()
    },
    after: async () => {
      for (const door of doors) await door.shut()
      await redis.close()
    },
    fresh: async log => {
      const door = await redisDoor()
      doors.push(door)
      const prefix = testPrefix()
      return {
        feed: new ValkeyFeed({ url: door.url, prefix, log }),
        notify: async (channel, payload) => {
          await redis.publish(feedChannelKey(prefix, channel), payload)
        },
        outage: async during => {
          await door.shut()
          await wait(100)
          during?.()
          await door.open()
        }
      }
    },
    late: async log => {
      const door = await redisDoor(false)
      doors.push(door)
      return {
        feed: new ValkeyFeed({ url: door.url, prefix: testPrefix(), log }),
        arrive: door.open
      }
    }
  }
}

for (const transport of [postgresTransport(), valkeyTransport()]) {
  describe(`what every change feed promises, on ${transport.name}`, function () {
    this.timeout(20000)
    let feeds: ChangeFeed[] = []
    let lines: string[] = []
    const log = (line: string): void => {
      lines.push(line)
    }
    const fresh = async (): Promise<FeedUnderTest> => {
      lines = []
      const made = await transport.fresh(log)
      feeds.push(made.feed)
      return made
    }
    const late = async (): Promise<LateFeed> => {
      lines = []
      const made = await transport.late(log)
      feeds.push(made.feed)
      return made
    }

    before(async function () {
      await transport.before()
    })

    afterEach(async function () {
      for (const feed of feeds) await feed.close()
      feeds = []
    })

    after(async function () {
      await transport.after()
    })

    it('says first to each handler, however they arrive, and only once the caller has its subscription', async function () {
      const { feed } = await fresh()
      const early = hearer()
      const alongside = hearer()
      await Promise.all([
        feed.subscribe('game_changes', early).listening,
        feed.subscribe('screen_scopes', alongside).listening
      ])
      const late = hearer()
      await feed.subscribe('chat_changes', late).listening
      const sameChannel = hearer()
      const { listening } = feed.subscribe('game_changes', sameChannel)
      expect(sameChannel.listenings).deep.equals([])
      await listening
      for (const each of [early, alongside, late, sameChannel])
        expect(each.listenings).deep.equals([true])
    })

    it('gives a notice, in order, only to its own channel’s handlers', async function () {
      const { feed, notify } = await fresh()
      const games = hearer()
      const moreGames = hearer()
      const chat = hearer()
      await Promise.all([
        feed.subscribe('game_changes', games).listening,
        feed.subscribe('game_changes', moreGames).listening,
        feed.subscribe('chat_changes', chat).listening
      ])
      const sent = Array.from({ length: 20 }, (_, index) => String(index))
      for (const payload of sent) await notify('game_changes', payload)
      await notify('screen_scopes', 'nobody here')
      await notify('chat_changes', 'a chat')
      await until(
        () => moreGames.payloads.length === 20 && chat.payloads.length === 1,
        'every notice'
      )
      expect(games.payloads).deep.equals(sent)
      expect(moreGames.payloads).deep.equals(sent)
      expect(chat.payloads).deep.equals(['a chat'])
    })

    it('tells each handler once after a loss, says true to one who came during it, and hears again', async function () {
      const { feed, notify, outage } = await fresh()
      const games = hearer()
      const moreGames = hearer()
      const chat = hearer()
      await Promise.all([
        feed.subscribe('game_changes', games).listening,
        feed.subscribe('game_changes', moreGames).listening,
        feed.subscribe('chat_changes', chat).listening
      ])
      const during = hearer()
      await outage(() => {
        // Nothing is said until it is back.
        expect(games.listenings).deep.equals([true])
        feed.subscribe('feed_probe', during)
      })
      await until(() => chat.listenings.length === 2, 'the return')
      await until(() => games.listenings.length === 2, 'the return')
      await until(() => moreGames.listenings.length === 2, 'the return')
      await until(() => during.listenings.length === 1, 'the new channel')
      expect(during.listenings).deep.equals([true])
      await notify('chat_changes', 'after')
      await until(() => chat.payloads.length === 1, 'a notice after the return')
      for (const each of [games, moreGames, chat])
        expect(each.listenings).deep.equals([true, false])
    })

    it('says one gap per outage, however many there are', async function () {
      const { feed, outage } = await fresh()
      const games = hearer()
      await feed.subscribe('game_changes', games).listening
      for (const returns of [2, 3]) {
        await outage()
        await until(() => games.listenings.length === returns, 'the return')
      }
      await wait(50)
      expect(games.listenings).deep.equals([true, false, false])
    })

    it('settles when a first attempt fails, keeps trying, and calls the return a gap, but says true to one who came during it', async function () {
      const { feed, arrive } = await late()
      const early = hearer()
      await feed.subscribe('game_changes', early).listening
      expect(early.listenings).deep.equals([])
      const during = hearer()
      feed.subscribe('game_changes', during)
      await arrive()
      await until(() => early.listenings.length === 1, 'the return')
      await until(() => during.listenings.length === 1, 'the later handler')
      expect(early.listenings).deep.equals([false])
    })

    it('stops only the handler it was given, and more than once if asked', async function () {
      const { feed, notify, outage } = await fresh()
      const leaving = hearer()
      const staying = hearer()
      const subscription = feed.subscribe('game_changes', leaving)
      await Promise.all([
        subscription.listening,
        feed.subscribe('game_changes', staying).listening
      ])
      subscription.stop()
      subscription.stop()
      await notify('game_changes', 'after')
      await until(() => staying.payloads.length === 1, 'the notice')
      expect(leaving.payloads).deep.equals([])
      await outage()
      await until(() => staying.listenings.length === 2, 'the return')
      expect(leaving.listenings).deep.equals([true])
    })

    it('settles a subscription stopped before its channel is in place, and tells it nothing', async function () {
      const { feed } = await fresh()
      const leaving = hearer()
      const subscription = feed.subscribe('game_changes', leaving)
      subscription.stop()
      await subscription.listening
      const staying = hearer()
      await feed.subscribe('game_changes', staying).listening
      expect(leaving.listenings).deep.equals([])
      // Its channel was in place when it went: still nothing.
      const alsoLeaving = hearer()
      const quick = feed.subscribe('game_changes', alsoLeaving)
      quick.stop()
      await quick.listening
      await wait(10)
      expect(alsoLeaving.listenings).deep.equals([])
    })

    it('keeps one handler’s failure from the others, and logs it', async function () {
      const { feed, notify } = await fresh()
      const fine = hearer()
      await Promise.all([
        feed.subscribe('game_changes', {
          onPayload: () => {
            throw new Error('a payload went wrong')
          },
          onListening: () => {
            throw new Error('a listening went wrong')
          }
        }).listening,
        feed.subscribe('game_changes', fine).listening
      ])
      await notify('game_changes', 'one')
      await until(() => fine.payloads.length === 1, 'the notice')
      expect(fine.listenings).deep.equals([true])
      expect(lines.some(line => line.includes('a payload went wrong'))).equals(
        true
      )
      expect(
        lines.some(line => line.includes('a listening went wrong'))
      ).equals(true)
    })

    it('can close while still connecting, and answers a subscription after it closed', async function () {
      const { feed } = await fresh()
      const games = hearer()
      const { listening } = feed.subscribe('game_changes', games)
      await feed.close()
      await listening
      expect(games.listenings).deep.equals([])
      const after = hearer()
      const closed = feed.subscribe('game_changes', after)
      await closed.listening
      closed.stop()
      expect(after.listenings).deep.equals([])
    })
  })
}
