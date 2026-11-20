import { type AddressInfo, connect, createServer, type Socket } from 'node:net'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { SocketClosedUnexpectedlyError } from 'redis'

import { NO_OVERRIDES } from '../../common/scoreboard'
import {
  quiet,
  testPrefix,
  testRedisUrl,
  until
} from '../../test/scoreboardKit'
import { silentValkey, untilAsked } from '../../test/silentValkey'
import { makeValkeyCache } from '../cache/valkeyCache'
import { feedChannelKey, ValkeyFeed } from '../changeFeed/valkeyFeed'
import { livePlaylistKey, ValkeyPlaylistSink } from '../media/livePlaylists'
import {
  makeScoreboardClient,
  makeScoreboardStore,
  makeScoreboardSubscriber,
  quit,
  type ScoreboardClient,
  type ScoreboardHash,
  ScoreboardUnavailable
} from '../scoreboard/scoreboardStore'
import { closeValkey, runValkey, ValkeyTimeout } from './client'

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('Valkey keepalive and bounded recovery', function () {
  this.timeout(15000)
  let admin: ScoreboardClient
  let prefix: string
  const clients: ScoreboardClient[] = []
  const closing: Array<() => Promise<void>> = []

  async function opened(
    role = 'scoreboard',
    pingInterval = 60000
  ): Promise<ScoreboardClient> {
    const client = makeScoreboardClient(testRedisUrl, quiet, role, '', {
      pingInterval
    })
    clients.push(client)
    await client.connect()
    return client
  }

  beforeEach(async function () {
    prefix = testPrefix()
    admin = await opened('test-admin')
  })

  afterEach(async function () {
    for (const close of closing.splice(0)) await close()
    for await (const keys of admin.scanIterator({ MATCH: `${prefix}:*` }))
      if (keys.length > 0) await admin.del(keys)
    for (const client of clients.splice(0)) if (client.isOpen) client.destroy()
  })

  async function kill(client: ScoreboardClient): Promise<void> {
    const id = await client.clientId()
    expect(await admin.clientKill({ filter: 'ID', id })).equals(1)
  }

  async function bounded<T>(
    budgetMs: number,
    run: () => Promise<T>
  ): Promise<T> {
    const start = Date.now()
    const result = await run()
    expect(Date.now() - start).lessThan(budgetMs + 100)
    return result
  }

  it('shares readiness listeners during a concurrent initial connection', async function () {
    const client = makeScoreboardClient(testRedisUrl, quiet)
    clients.push(client)
    const baseline = ['ready', 'error', 'end'].map(event =>
      client.listenerCount(event)
    )
    const connecting = client.connect()
    const commands = Array.from(
      { length: 30 },
      async () => await runValkey(client, async () => await client.ping())
    )
    expect(
      ['ready', 'error', 'end'].map(event => client.listenerCount(event))
    ).deep.equals(baseline)
    await connecting
    expect(await Promise.all(commands)).deep.equals(Array(30).fill('PONG'))
    expect(
      ['ready', 'error', 'end'].map(event => client.listenerCount(event))
    ).deep.equals(baseline)
  })

  it('closes a silent transport within its budget after an unanswered keepalive', async function () {
    const peer = await silentValkey()
    const client = makeScoreboardClient(peer.url, quiet, 'test-shutdown', '', {
      pingInterval: 20
    })
    clients.push(client)
    try {
      await client.connect()
      peer.silence()
      await until('an unanswered keepalive', () =>
        peer.commands.includes('PING')
      )
      expect(client.isReady).equals(true)
      const started = Date.now()
      await quit(client)
      expect(Date.now() - started).within(480, 650)
      expect(client.isOpen).equals(false)
      expect(client.isReady).equals(false)
      await quit(client)
    } finally {
      await peer.close()
    }
  })

  it('closes the cache transport after a silent keepalive within 200 ms', async function () {
    const peer = await silentValkey()
    const cache = makeValkeyCache({
      redis: { url: peer.url, prefix },
      databaseUrl: 'postgres://localhost/test',
      log: quiet,
      clientOptions: { pingInterval: 20 }
    })
    try {
      await untilAsked(cache, peer)
      const before = peer.commands.filter(command => command === 'PING').length
      peer.silence()
      await until(
        'an unanswered cache keepalive',
        () =>
          peer.commands.filter(command => command === 'PING').length > before
      )
      const started = Date.now()
      await cache.close()
      expect(Date.now() - started).within(180, 350)
      expect(cache.answering?.()).equals(false)
      await cache.close()
    } finally {
      await peer.close()
    }
  })

  it('drains command and subscribed clients before closing', async function () {
    const client = await opened()
    const subscriber = makeScoreboardSubscriber(client, quiet)
    clients.push(subscriber)
    await subscriber.connect()
    await subscriber.subscribe(`${prefix}:closing`, quiet)
    const writing = client.set(`${prefix}:drained`, 'saved')
    await Promise.all([quit(client), quit(subscriber)])
    expect(await writing).equals('OK')
    expect(await admin.get(`${prefix}:drained`)).equals('saved')
    expect(client.isReady || subscriber.isReady).equals(false)
  })

  it('keeps command and subscribed connections active while a silent control ages', async function () {
    const client = await opened('scoreboard', 100)
    const subscriber = makeScoreboardSubscriber(client, quiet)
    clients.push(subscriber)
    await subscriber.connect()
    const control = await opened('test-silent', 0)
    const ids = await Promise.all([
      client.clientId(),
      subscriber.clientId(),
      control.clientId()
    ])
    const heard: string[] = []
    await subscriber.subscribe(`${prefix}:ping`, message => heard.push(message))
    let pings = 0
    subscriber.on('ping-interval', () => {
      pings++
    })
    await sleep(2200)
    const rows = await admin.clientList({ ID: ids.map(String) })
    const command = rows.find(row => row.id === ids[0])!
    const sub = rows.find(row => row.id === ids[1])!
    const silent = rows.find(row => row.id === ids[2])!
    expect(command.name).equals(`scoreboard-${process.pid}`)
    expect(sub.name).equals(`scoreboard-sub-${process.pid}`)
    // CLIENT LIST counts whole seconds; even a recent PING can show 1.
    expect(command.idle).at.most(1)
    expect(sub.idle).at.most(1)
    expect(silent.idle).at.least(2)
    expect(pings).greaterThan(5)
    expect(subscriber.options?.pingInterval).equals(100)
    await admin.publish(`${prefix}:ping`, 'still listening')
    await until('subscriber after idle', () => heard.length === 1)
    expect(heard).deep.equals(['still listening'])
    expect(await admin.clientKill({ filter: 'ID', id: ids[1] })).equals(1)
    await until('subscriber reconnected', async () =>
      (await admin.clientList()).some(
        row => row.name === sub.name && row.id !== sub.id && row.sub > 0
      )
    )
    await admin.publish(`${prefix}:ping`, 'listening again')
    await until('subscriber after reconnect', () => heard.length === 2)
  })

  it('recovers the first scoreboard write and read after killing their owned connection', async function () {
    const client = await opened()
    const store = makeScoreboardStore({ client, prefix })
    await kill(client)
    expect(
      (
        await bounded(
          500,
          async () => await store.mergeWatcher('game', { balls: 2 }, Date.now())
        )
      ).kind
    ).equals('written')
    await kill(client)
    expect(
      (await bounded(500, async () => await store.readScoreboard('game')))
        ?.watcher?.state.balls
    ).equals(2)
  })

  it('recovers cache set and get without extending the 200 ms budget', async function () {
    const name = `${prefix}:cache`
    const cache = makeValkeyCache({
      redis: { url: testRedisUrl, prefix },
      databaseUrl: 'postgres://localhost/test',
      log: quiet,
      clientOptions: { name }
    })
    closing.push(cache.close)
    const killCache = async (): Promise<void> => {
      let id: number | undefined
      await until('owned cache connection', async () => {
        id = (await admin.clientList()).find(row => row.name === name)?.id
        return id != null
      })
      expect(await admin.clientKill({ filter: 'ID', id: id! })).equals(1)
    }
    await cache.set('initial', 'ready', 60000)
    await killCache()
    await bounded(200, async () => {
      await cache.set('value', 'saved', 60000)
    })
    expect(await admin.get(`${prefix}:value`)).equals('saved')
    await killCache()
    expect(await bounded(200, async () => await cache.get('value'))).equals(
      'saved'
    )
    expect(cache.answering?.()).equals(true)
    await cache.close()
    expect(await cache.get('value')).equals(null)
    expect(cache.answering?.()).equals(false)
  })

  it('recovers an ephemeral feed publish and leader read on the first call after loss', async function () {
    const feed = new ValkeyFeed({ url: testRedisUrl, prefix, log: quiet })
    closing.push(async () => {
      await feed.close()
    })
    const subscriber = makeScoreboardSubscriber(admin, quiet, 'test-feed-sub')
    clients.push(subscriber)
    await subscriber.connect()
    const heard: string[] = []
    await subscriber.subscribe(
      feedChannelKey(prefix, 'game_changes'),
      message => heard.push(message)
    )
    await feed.leader()
    const publisher = (feed as unknown as { publisher: ScoreboardClient })
      .publisher
    expect(await publisher.clientGetName()).equals(
      `feed-publisher-${process.pid}`
    )
    await kill(publisher)
    await bounded(500, async () => {
      await feed.publishEphemeral('game_changes', 'notice')
    })
    await until('feed notice', () => heard.length === 1)
    expect(heard).deep.equals(['notice'])
    await kill(publisher)
    expect(await bounded(500, async () => await feed.leader())).equals(null)
    await feed.close()
    let rejected = false
    try {
      await feed.leader()
    } catch {
      rejected = true
    }
    expect(rejected).equals(true)
  })

  it('pipelines healthy ephemeral bursts despite delayed publication replies', async function () {
    const feed = new ValkeyFeed({ url: testRedisUrl, prefix, log: quiet })
    closing.push(async () => {
      await feed.close()
    })
    await feed.leader()
    const publisher = (feed as unknown as { publisher: ScoreboardClient })
      .publisher
    const publish = publisher.publish.bind(publisher)
    const subscriber = makeScoreboardSubscriber(admin, quiet)
    clients.push(subscriber)
    await subscriber.connect()
    const heard: string[] = []
    await subscriber.subscribe(
      feedChannelKey(prefix, 'chat_changes'),
      payload => heard.push(payload)
    )
    Object.assign(publisher, {
      publish: async (...args: Parameters<typeof publish>) => {
        const reply = await publish(...args)
        await sleep(20)
        return reply
      }
    })
    const notices = Array.from({ length: 40 }, (_, i) => `notice-${i}`)
    await Promise.all(
      notices.map(async payload => {
        await feed.publishEphemeral('chat_changes', payload)
      })
    )
    await until('the complete burst', () => heard.length === notices.length)
    expect(heard).deep.equals(notices)
  })

  it('rejects an uncertain older ephemeral notice instead of replaying it after a newer one', async function () {
    const feed = new ValkeyFeed({ url: testRedisUrl, prefix, log: quiet })
    closing.push(async () => {
      await feed.close()
    })
    await feed.leader()
    const publisher = (feed as unknown as { publisher: ScoreboardClient })
      .publisher
    const publish = publisher.publish.bind(publisher)
    const sent: string[] = []
    let lost = false
    Object.assign(publisher, {
      publish: async (...args: Parameters<typeof publish>) => {
        if (args[1] === 'first' && !lost) {
          lost = true
          await sleep(30)
          throw new SocketClosedUnexpectedlyError()
        }
        sent.push(String(args[1]))
        return await publish(...args)
      }
    })
    const outcomes = await Promise.allSettled([
      feed.publishEphemeral('game_changes', 'first'),
      feed.publishEphemeral('game_changes', 'second')
    ])
    expect(outcomes.map(result => result.status)).deep.equals([
      'rejected',
      'fulfilled'
    ])
    expect(sent).deep.equals(['second'])
    expect(String((outcomes[0] as PromiseRejectedResult).reason)).contains(
      'A later notice was published'
    )
  })

  it('does not retry an ephemeral notice after the feed closes', async function () {
    const feed = new ValkeyFeed({ url: testRedisUrl, prefix, log: quiet })
    await feed.leader()
    const publisher = (feed as unknown as { publisher: ScoreboardClient })
      .publisher
    let resume = (): void => undefined
    const paused = new Promise<void>(resolve => {
      resume = resolve
    })
    let attempts = 0
    Object.assign(publisher, {
      publish: async () => {
        attempts++
        await paused
        throw new SocketClosedUnexpectedlyError()
      }
    })
    const publishing = feed.publishEphemeral('chat_changes', 'typing').then(
      () => 'sent',
      () => 'failed'
    )
    await feed.close()
    resume()
    expect(await publishing).equals('failed')
    expect(attempts).equals(1)
  })

  it('gives every caller during the first connection its budget', async function () {
    // A proxy that answers the connection only after 700 ms, as a slow TLS
    // handshake would.
    const upstream = new URL(testRedisUrl)
    const sockets: Socket[] = []
    const proxy = createServer(socket => {
      sockets.push(socket)
      setTimeout(() => {
        const out = connect(
          upstream.port === '' ? 6379 : Number(upstream.port),
          upstream.hostname
        )
        sockets.push(out)
        socket.pipe(out).pipe(socket)
      }, 700)
    })
    await new Promise<void>(resolve => {
      proxy.listen(0, '127.0.0.1', resolve)
    })
    closing.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => {
        proxy.close(resolve)
      })
    })
    const { port } = proxy.address() as AddressInfo
    const feed = new ValkeyFeed({
      url: `redis://127.0.0.1:${port}${upstream.pathname}`,
      prefix,
      log: quiet,
      connectWaitMs: 1500
    })
    closing.unshift(async () => {
      await feed.close()
    })
    const [first, second] = await Promise.all([
      feed.leader(),
      feed.leader(),
      feed.publishEphemeral('game_changes', 'notice')
    ])
    expect(first).equals(null)
    expect(second).equals(null)
  })

  it('uses one first-connection budget and a 500 ms budget on later feed calls', async function () {
    const feed = new ValkeyFeed({
      url: testRedisUrl,
      prefix,
      log: quiet,
      connectWaitMs: 100
    })
    closing.push(async () => {
      await feed.close()
    })
    const publisher = (feed as unknown as { publisher: ScoreboardClient })
      .publisher
    let attempts = 0
    Object.assign(publisher, {
      get: async () => {
        attempts++
        return await new Promise(() => undefined)
      }
    })
    for (const budget of [100, 500]) {
      const started = Date.now()
      let failed = false
      try {
        await feed.leader()
      } catch {
        failed = true
      }
      expect(failed).equals(true)
      expect(Date.now() - started).within(budget - 10, budget + 150)
    }
    expect(attempts).equals(2)
  })

  for (const mutation of ['overrides', 'reset', 'watcher'] as const) {
    it(`does not replay an applied ${mutation} over another worker's newer state`, async function () {
      const client = await opened()
      const store = makeScoreboardStore({ client, prefix })
      const other = makeScoreboardStore({ client: admin, prefix })
      const start = Date.now()
      await store.mergeWatcher('game', { balls: 1 }, start)
      const subscriber = makeScoreboardSubscriber(
        admin,
        quiet,
        'test-results-sub'
      )
      clients.push(subscriber)
      await subscriber.connect()
      const heard: string[] = []
      await subscriber.subscribe(store.channel, message => heard.push(message))
      const original = client.writeScoreboard.bind(client)
      let tries = 0
      let expected: ScoreboardHash | undefined
      let originalReply = ''
      Object.assign(client, {
        writeScoreboard: async (...args: Parameters<typeof original>) => {
          const reply = await original(...args)
          if (++tries === 1) {
            originalReply = reply
            await other.writeOverrides(
              'game',
              {
                ...NO_OVERRIDES,
                overrideScoreEnabled: true,
                overrideScore: { homeScore: 7, awayScore: 3 }
              },
              start
            )
            await other.mergeWatcher('game', { balls: 3 }, start)
            expected = await other.readScoreboard('game')
            throw new SocketClosedUnexpectedlyError()
          }
          expect(reply).equals(originalReply)
          expect(await admin.pTTL(args[1])).within(9000, 10000)
          return reply
        }
      })
      if (mutation === 'overrides')
        await store.writeOverrides('game', NO_OVERRIDES, start)
      else if (mutation === 'reset') await store.resetScoreboard('game', start)
      else await store.mergeWatcher('game', { balls: 0 }, start)
      expect(tries).equals(2)
      expect(await store.readScoreboard('game')).deep.equals(expected)
      await sleep(30)
      expect(heard).length(3)
    })
  }

  it('recovers playlist append and replace after a killed connection', async function () {
    const client = await opened('ingest')
    const sink = new ValkeyPlaylistSink(client, prefix)
    await sink.replace('video', 'one\n')
    await kill(client)
    await bounded(1000, async () => {
      await sink.append('video', 'two\n', 'one\ntwo\n')
    })
    expect(
      (await admin.lRange(livePlaylistKey(prefix, 'video'), 0, -1)).join('')
    ).equals('one\ntwo\n')
    await kill(client)
    await bounded(1000, async () => {
      await sink.replace('video', 'three\n')
    })
    expect(
      await admin.lRange(livePlaylistKey(prefix, 'video'), 0, -1)
    ).deep.equals(['three\n'])
  })

  it('replaces the body on an uncertain append instead of appending its segment twice', async function () {
    const client = await opened('ingest')
    const sink = new ValkeyPlaylistSink(client, prefix)
    await sink.replace('video', 'one\n')
    const multi = client.multi.bind(client)
    let transactions = 0
    Object.assign(client, {
      multi: (...args: Parameters<typeof multi>) => {
        const transaction = multi(...args)
        const exec = transaction.exec.bind(transaction)
        Object.assign(transaction, {
          exec: async () => {
            const result = await exec()
            if (++transactions === 1) throw new SocketClosedUnexpectedlyError()
            return result
          }
        })
        return transaction
      }
    })
    await sink.append('video', 'two\n', 'one\ntwo\n')
    expect(transactions).equals(2)
    expect(
      await admin.lRange(livePlaylistKey(prefix, 'video'), 0, -1)
    ).deep.equals(['one\ntwo\n'])
  })

  it('recovers a slow write that landed, publishing it once, with its result in the game key slot', async function () {
    const client = await opened()
    const store = makeScoreboardStore({ client, prefix })
    const subscriber = makeScoreboardSubscriber(admin, quiet, 'test-slow-sub')
    clients.push(subscriber)
    await subscriber.connect()
    const heard: string[] = []
    await subscriber.subscribe(store.channel, message => heard.push(message))
    const original = client.writeScoreboard.bind(client)
    const resultKeys: string[] = []
    Object.assign(client, {
      writeScoreboard: async (...args: Parameters<typeof original>) => {
        resultKeys.push(args[1])
        const reply = await original(...args)
        if (resultKeys.length === 1) await sleep(600)
        return reply
      }
    })
    const written = await store.mergeWatcher('game', { balls: 2 }, Date.now())
    expect(written.kind).equals('written')
    expect(resultKeys).length(2)
    expect(resultKeys[1]).equals(resultKeys[0])
    expect(
      resultKeys[0].startsWith(
        `${prefix}:scoreboardResult:{${store.keyOf('game')}}:`
      )
    ).equals(true)
    await until('the publication', () => heard.length > 0)
    await sleep(50)
    expect(heard).length(1)
  })

  it('does not replay a write that waited for a reconnect, failing in one budget', async function () {
    const valkey = await silentValkey()
    closing.push(valkey.close)
    valkey.silence()
    const client = makeScoreboardClient(valkey.url, quiet, 'never-ready')
    clients.push(client)
    client.connect().catch(() => undefined)
    let sent = 0
    const original = client.writeScoreboard.bind(client)
    Object.assign(client, {
      writeScoreboard: async (...args: Parameters<typeof original>) => {
        sent++
        return await original(...args)
      }
    })
    const store = makeScoreboardStore({ client, prefix })
    const started = Date.now()
    let problem: unknown
    try {
      await store.mergeWatcher('game', { balls: 1 }, Date.now())
    } catch (error) {
      problem = error
    }
    expect(problem).instanceOf(ScoreboardUnavailable)
    expect(sent).equals(0)
    expect(Date.now() - started).within(480, 700)
  })

  for (const writing of [false, true])
    it(`reconnects a connection whose keepalive goes unanswered${writing ? ', however much is written to it' : ''}`, async function () {
      const valkey = await silentValkey()
      closing.push(valkey.close)
      const client = makeScoreboardClient(valkey.url, quiet, 'black-hole', '', {
        pingInterval: 100,
        silenceGraceMs: 200
      })
      clients.push(client)
      await client.connect()
      const errors: unknown[] = []
      client.on('error', error => {
        errors.push(error)
        valkey.answer()
      })
      // Every write resets a socket's own idle timer.
      const writes = writing
        ? setInterval(() => {
            client.get('silent').catch(() => undefined)
          }, 20)
        : undefined
      try {
        valkey.silence()
        await until('the silence to be noticed', () => errors.length > 0, 3000)
        expect(errors[0]).instanceOf(ValkeyTimeout)
        await until('the reconnect', () => client.isReady, 3000)
        expect(await client.ping()).equals('OK')
      } finally {
        clearInterval(writes)
      }
    })

  it('waits through the reconnect its keepalive watchdog starts, saying nothing of its own disconnect', async function () {
    const valkey = await silentValkey()
    closing.push(valkey.close)
    const lines: string[] = []
    const client = makeScoreboardClient(
      valkey.url,
      line => lines.push(line),
      'watched',
      '',
      { pingInterval: 100, silenceGraceMs: 200 }
    )
    clients.push(client)
    await client.connect()
    let during: Promise<string> | undefined
    client.on('error', () => {
      valkey.answer()
      during ??= runValkey(client, async () => await client.ping(), 500, true)
    })
    valkey.silence()
    await until('the silence to be noticed', () => during != null, 3000)
    expect(await during).equals('OK')
    await sleep(50)
    expect(lines.some(line => line.includes('Disconnects client'))).equals(
      false
    )
  })

  for (const close of ['closeValkey', 'close'] as const)
    it(`leaves a client being closed by ${close} alone when its keepalive goes unanswered`, async function () {
      const valkey = await silentValkey()
      closing.push(valkey.close)
      const client = makeScoreboardClient(valkey.url, quiet, 'closing', '', {
        pingInterval: 100,
        silenceGraceMs: 200
      })
      clients.push(client)
      await client.connect()
      const errors: unknown[] = []
      client.on('error', error => errors.push(error))
      valkey.silence()
      // The close waits on the silent peer past the watchdog's 300 ms.
      const closed =
        close === 'closeValkey'
          ? closeValkey(client, 1000)
          : client.close().catch(() => undefined)
      await sleep(600)
      expect(errors.filter(error => error instanceof ValkeyTimeout)).length(0)
      if (client.isOpen) client.destroy()
      await closed
    })

  it('never sends a timeline announcement twice after a lost connection', async function () {
    const client = await opened()
    const store = makeScoreboardStore({ client, prefix })
    let sent = 0
    Object.assign(client, {
      publish: async () => {
        sent++
        throw new SocketClosedUnexpectedlyError()
      }
    })
    let problem: unknown
    try {
      await store.announceTimeline('game')
    } catch (error) {
      problem = error
    }
    expect(problem).instanceOf(ScoreboardUnavailable)
    expect(sent).equals(1)
  })

  it('bounds unanswered scoreboard commands and preserves server errors', async function () {
    const client = await opened()
    const store = makeScoreboardStore({ client, prefix })
    await admin.set(store.keyOf('wrong'), 'wrong type')
    let problem: unknown
    try {
      await store.readScoreboard('wrong')
    } catch (error) {
      problem = error
    }
    expect(String(problem)).contains('WRONGTYPE')
    expect(problem).not.instanceOf(ScoreboardUnavailable)
    Object.assign(client, {
      exists: async () => await new Promise(() => undefined)
    })
    const started = Date.now()
    try {
      await store.exists('silent')
    } catch (error) {
      problem = error
    }
    expect(problem).instanceOf(ScoreboardUnavailable)
    expect(Date.now() - started).within(480, 650)
    client.destroy()
    try {
      await store.exists('closed')
    } catch (error) {
      problem = error
    }
    expect(problem).instanceOf(ScoreboardUnavailable)
  })
})
