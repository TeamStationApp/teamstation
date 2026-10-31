import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import type { FeedChannel, FeedHandlers } from './feed'
import { makeChangeFeed } from './makeChangeFeed'
import { FEED_APPLICATION_NAME, PostgresFeed } from './postgresFeed'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Never saw ${what}`)
    await wait(5)
  }
}

/** A handler that writes down what it hears. */
function hearer(): Required<FeedHandlers> & {
  payloads: Array<string | undefined>
  listenings: boolean[]
} {
  const payloads: Array<string | undefined> = []
  const listenings: boolean[] = []
  return {
    payloads,
    listenings,
    onPayload: payload => {
      payloads.push(payload)
    },
    onListening: first => {
      listenings.push(first)
    }
  }
}

describe('the Postgres change feed', function () {
  this.timeout(30000)
  const stamp = `${Date.now()}_${process.pid}`
  const scratchName = `teamstation_feed_${stamp}`
  const lateName = `teamstation_feed_late_${stamp}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
  const lateUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${lateName}`)
  const feeds: PostgresFeed[] = []
  let admin: Pool
  let db: Kysely<Database>
  let poker: Pool
  let lines: string[]

  const feedOf = (databaseUrl = scratchUrl, retryMs = 50): PostgresFeed => {
    lines = []
    const made = new PostgresFeed({
      databaseUrl,
      retryMs,
      log: line => lines.push(line)
    })
    feeds.push(made)
    return made
  }
  const notify = async (
    channel: FeedChannel,
    payload: string
  ): Promise<void> => {
    await poker.query('select pg_notify($1, $2)', [channel, payload])
  }
  const connections = async (): Promise<number> =>
    (
      await admin.query(
        `select pid from pg_stat_activity
         where datname = $1 and application_name = $2`,
        [scratchName, FEED_APPLICATION_NAME]
      )
    ).rows.length
  const cut = async (): Promise<void> => {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and application_name = $2`,
      [scratchName, FEED_APPLICATION_NAME]
    )
  }
  const noConnections = async (): Promise<void> => {
    const deadline = Date.now() + 5000
    while ((await connections()) > 0) {
      if (Date.now() > deadline) throw new Error('A connection stayed open')
      await wait(10)
    }
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${scratchName}`)
    db = makeDatabase(scratchUrl)
    poker = new Pool({ connectionString: scratchUrl })
  })

  after(async function () {
    for (const feed of feeds) await feed.close()
    await poker.end()
    await db.destroy()
    await admin.query(`drop database if exists ${scratchName} with (force)`)
    await admin.query(`drop database if exists ${lateName} with (force)`)
    await admin.end()
  })

  it('holds one connection for every channel, however they arrive, and says first', async function () {
    const feed = feedOf()
    const early = hearer()
    const alongside = hearer()
    await Promise.all([
      feed.subscribe('game_changes', early).listening,
      feed.subscribe('screen_scopes', alongside).listening
    ])
    const late = hearer()
    const sameChannel = hearer()
    await Promise.all([
      feed.subscribe('chat_changes', late).listening,
      feed.subscribe('chat_dirty', hearer()).listening,
      feed.subscribe('game_stats', hearer()).listening,
      feed.subscribe('feed_probe', hearer()).listening
    ])
    // Told after the caller has its subscription, even with nothing to wait for.
    const { listening } = feed.subscribe('game_changes', sameChannel)
    expect(sameChannel.listenings).deep.equals([])
    await listening
    for (const each of [early, alongside, late, sameChannel])
      expect(each.listenings).deep.equals([true])
    expect(await connections()).equals(1)
    await feed.close()
    await noConnections()
  })

  it('gives a notify only to its own channel’s handlers', async function () {
    const feed = feedOf()
    const games = hearer()
    const moreGames = hearer()
    const chat = hearer()
    await Promise.all([
      feed.subscribe('game_changes', games).listening,
      feed.subscribe('game_changes', moreGames).listening,
      feed.subscribe('chat_changes', chat).listening
    ])
    await notify('game_changes', 'a game')
    await until(() => moreGames.payloads.length === 1, 'the notify')
    await notify('screen_scopes', 'nobody here')
    await notify('chat_changes', 'a chat')
    await until(() => chat.payloads.length === 1, 'the chat notify')
    expect(games.payloads).deep.equals(['a game'])
    expect(moreGames.payloads).deep.equals(['a game'])
    expect(chat.payloads).deep.equals(['a chat'])
    await feed.close()
    await noConnections()
  })

  it('tells each handler once when it returns after a loss, and hears again on one connection', async function () {
    const feed = feedOf(scratchUrl, 300)
    const games = hearer()
    const moreGames = hearer()
    const chat = hearer()
    await Promise.all([
      feed.subscribe('game_changes', games).listening,
      feed.subscribe('game_changes', moreGames).listening,
      feed.subscribe('chat_changes', chat).listening
    ])
    await cut()
    await until(
      () => lines.some(line => line.includes('lost the feed connection')),
      'the loss'
    )
    // Nothing is said until it is back. A channel first asked for meanwhile
    // has no gap of its own to hear about.
    expect(games.listenings).deep.equals([true])
    const during = hearer()
    feed.subscribe('feed_probe', during)
    await until(() => chat.listenings.length === 2, 'the return')
    await until(() => during.listenings.length === 1, 'the new channel')
    for (const each of [games, moreGames, chat])
      expect(each.listenings).deep.equals([true, false])
    expect(during.listenings).deep.equals([true])
    await notify('chat_changes', 'after')
    await until(() => chat.payloads.length === 1, 'a notify after the return')
    expect(await connections()).equals(1)
    await wait(350)
    expect(chat.listenings).deep.equals([true, false])
    await feed.close()
    await noConnections()
  })

  it('settles listening when the first attempt fails, keeps trying, and calls the return a gap', async function () {
    const feed = feedOf(lateUrl, 30)
    const games = hearer()
    const { listening } = feed.subscribe('game_changes', games)
    await listening
    expect(lines).to.have.length(1)
    expect(lines[0]).includes('lost the feed connection')
    expect(games.listenings).deep.equals([])
    await until(() => lines.length >= 3, 'more attempts')
    await admin.query(`create database ${lateName}`)
    await until(() => games.listenings.length > 0, 'the return')
    expect(games.listenings).deep.equals([false])
    await feed.close()
  })

  it('stops only the handler it was given', async function () {
    const feed = feedOf()
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
    await until(() => staying.payloads.length === 1, 'the notify')
    expect(leaving.payloads).deep.equals([])
    await cut()
    await until(() => staying.listenings.length === 2, 'the return')
    expect(leaving.listenings).deep.equals([true])
    await feed.close()
  })

  it('settles a subscription stopped before its channel is in place, and tells it nothing', async function () {
    const feed = feedOf()
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
    await feed.close()
  })

  it('keeps one handler’s failure from the others, and logs it', async function () {
    const feed = feedOf()
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
    await until(() => fine.payloads.length === 1, 'the notify')
    expect(fine.listenings).deep.equals([true])
    expect(lines.some(line => line.includes('a payload went wrong'))).equals(
      true
    )
    expect(lines.some(line => line.includes('a listening went wrong'))).equals(
      true
    )
    await feed.close()
  })

  it('treats a LISTEN that fails like a lost connection', async function () {
    const feed = feedOf(scratchUrl, 10_000)
    await feed.subscribe('not a channel' as FeedChannel, hearer()).listening
    expect(lines[0]).includes('lost the feed connection')
    await feed.close()
  })

  it('stops trying when closed, and takes nothing after', async function () {
    const missing = testDatabaseUrl.replace(
      /\/[^/]*$/,
      `/${scratchName}_missing`
    )
    const feed = feedOf(missing, 20)
    const { listening } = feed.subscribe('game_changes', hearer())
    await listening
    await until(() => lines.length >= 2, 'a second attempt')
    await feed.close()
    const counted = lines.length
    await wait(100)
    expect(lines).to.have.length(counted)
    const after = hearer()
    const late = feed.subscribe('game_changes', after)
    await late.listening
    late.stop()
    expect(after.listenings).deep.equals([])
    expect(lines).to.have.length(counted)
  })

  it('can close while still connecting', async function () {
    const feed = feedOf()
    const games = hearer()
    const { listening } = feed.subscribe('game_changes', games)
    await feed.close()
    await listening
    expect(games.listenings).deep.equals([])
    await noConnections()
  })

  it('publishes an ephemeral notice through the database it is given', async function () {
    const feed = feedOf()
    const probes = hearer()
    await feed.subscribe('feed_probe', probes).listening
    await feed.publishEphemeral('feed_probe', 'hello', db)
    await until(() => probes.payloads.length === 1, 'the notice')
    expect(probes.payloads).deep.equals(['hello'])
    await feed.close()
  })

  it('is what a process gets from its config', async function () {
    const lines: string[] = []
    const feed = makeChangeFeed(
      {
        databaseUrl: scratchUrl,
        changeFeed: 'postgres',
        redis: { url: 'redis://127.0.0.1:1', prefix: '', caFile: '' }
      },
      line => lines.push(line)
    )
    expect(feed).instanceOf(PostgresFeed)
    await feed.subscribe('feed_probe', hearer()).listening
    expect(await connections()).equals(1)
    await feed.close()
    await noConnections()
  })
})
