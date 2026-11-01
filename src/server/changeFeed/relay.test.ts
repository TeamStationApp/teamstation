import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'
import { createClient } from 'redis'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import {
  quiet,
  requireRedis,
  testPrefix,
  testRedisUrl
} from '../../test/scoreboardKit'
import {
  makeScoreboardClient,
  type ScoreboardClient
} from '../scoreboard/scoreboardStore'
import { hearer, redisDoor, until, wait } from './feedTestKit'
import { runFeedProbe } from './probeCli'
import {
  type FeedRelay,
  type FeedRelayOptions,
  RELAY_APPLICATION_NAME,
  relayConnectionConfig,
  startFeedRelay
} from './relay'
import { feedControlKey, feedLeaderKey, ValkeyFeed } from './valkeyFeed'

const run = promisify(execFile)

const FAST: FeedRelayOptions = {
  pollMs: 20,
  jitterMs: 5,
  leaderTtlMs: 300,
  beatMs: 25
}

describe('the feed relay', function () {
  this.timeout(30000)
  const stamp = `${Date.now()}_${process.pid}`
  const scratchName = `teamstation_relay_${stamp}`
  const otherName = `teamstation_relay_other_${stamp}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
  const otherUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${otherName}`)
  const redis = createClient({ url: testRedisUrl })
  const running: FeedRelay[] = []
  const feeds: ValkeyFeed[] = []
  let admin: Pool
  let poker: Pool

  const relayOf = (
    prefix: string,
    identity: string,
    options: FeedRelayOptions & { log?: (line: string) => void } = {},
    databaseUrl = scratchUrl,
    redisUrl = testRedisUrl
  ): FeedRelay => {
    const relay = startFeedRelay(
      {
        databaseUrl,
        redis: { url: redisUrl, prefix, caFile: '' }
      },
      options.log ?? quiet,
      { ...FAST, identity, ...options }
    )
    running.push(relay)
    return relay
  }
  const leader = async (prefix: string): Promise<string | null> =>
    await redis.get(feedLeaderKey(prefix))
  const backends = async (database = scratchName): Promise<number> =>
    (
      await admin.query(
        `select pid from pg_stat_activity
         where datname = $1 and application_name = $2`,
        [database, RELAY_APPLICATION_NAME]
      )
    ).rows.length
  /** Writes down every control message of a prefix. */
  const controlOf = async (
    prefix: string
  ): Promise<{ kinds: string[]; stop: () => Promise<void> }> => {
    const kinds: string[] = []
    const listener = redis.duplicate()
    listener.on('error', quiet)
    await listener.connect()
    await listener.subscribe(feedControlKey(prefix), message => {
      kinds.push((JSON.parse(message) as { kind: string }).kind)
    })
    return {
      kinds,
      stop: async () => {
        await listener.close()
      }
    }
  }
  const feedOf = (prefix: string): ValkeyFeed => {
    const feed = new ValkeyFeed({ url: testRedisUrl, prefix, log: quiet })
    feeds.push(feed)
    return feed
  }
  const stopAll = async (): Promise<void> => {
    await Promise.all(
      running.splice(0).map(async relay => {
        await relay.stop()
      })
    )
    await until(async () => (await backends()) === 0, 'no relay connections')
  }

  before(async function () {
    await requireRedis()
    redis.on('error', quiet)
    await redis.connect()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${scratchName}`)
    await admin.query(`create database ${otherName}`)
    poker = new Pool({ connectionString: scratchUrl })
  })

  after(async function () {
    await Promise.all(
      running.map(async relay => {
        await relay.stop()
      })
    )
    for (const feed of feeds) await feed.close()
    await poker.end()
    await admin.query(`drop database if exists ${scratchName} with (force)`)
    await admin.query(`drop database if exists ${otherName} with (force)`)
    await admin.end()
    await redis.close()
  })

  it('lets only one of two candidates lead, publishes a resync, and a standby holds no connection', async function () {
    const prefix = testPrefix()
    const control = await controlOf(prefix)
    relayOf(prefix, 'first')
    relayOf(prefix, 'second')
    await until(async () => (await leader(prefix)) != null, 'a leader')
    await until(() => control.kinds.includes('heartbeat'), 'a heartbeat')
    await wait(200)
    expect(await backends()).equals(1)
    expect(control.kinds.filter(kind => kind === 'resync')).deep.equals([
      'resync'
    ])
    expect(control.kinds[0]).equals('resync')
    await control.stop()
    await stopAll()
    expect(await leader(prefix)).equals(null)
  })

  it('opens no Postgres connection while the key is present', async function () {
    const prefix = testPrefix()
    await redis.set(feedLeaderKey(prefix), 'someone else', { PX: 500 })
    const sawBackends: number[] = []
    relayOf(prefix, 'standby')
    for (let index = 0; index < 8; index += 1) {
      sawBackends.push(await backends())
      await wait(25)
    }
    expect(sawBackends.every(count => count === 0)).equals(true)
    await until(async () => (await leader(prefix)) === 'standby', 'takeover')
    await stopAll()
  })

  it('hands over when the leader loses its connection, and the next says resync', async function () {
    const prefix = testPrefix()
    const lines: string[] = []
    const control = await controlOf(prefix)
    relayOf(prefix, 'a', { log: line => lines.push(line) })
    await until(async () => (await leader(prefix)) === 'a', 'a leading')
    relayOf(prefix, 'b')
    await wait(50)
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and application_name = $2`,
      [scratchName, RELAY_APPLICATION_NAME]
    )
    await until(
      () => control.kinds.filter(kind => kind === 'resync').length === 2,
      'a second resync'
    )
    await until(async () => (await backends()) === 1, 'one connection')
    expect(lines.some(line => line.includes('stops leading'))).equals(true)
    await control.stop()
    await stopAll()
  })

  it('stands aside while another session holds the lock', async function () {
    const prefix = testPrefix()
    const holder = new Client({ connectionString: scratchUrl })
    await holder.connect()
    await holder.query(
      `select pg_advisory_lock(hashtextextended('teamstation:feed-relay', 0))`
    )
    relayOf(prefix, 'waiting')
    await wait(150)
    expect(await leader(prefix)).equals(null)
    await holder.end()
    await until(async () => (await leader(prefix)) === 'waiting', 'the lead')
    await stopAll()
  })

  it('publishes every channel in commit order', async function () {
    const prefix = testPrefix()
    const feed = feedOf(prefix)
    const games = hearer()
    await feed.subscribe('game_changes', games).listening
    relayOf(prefix, 'orderly')
    await until(() => games.listenings.length === 2, 'the resync')
    const sent = Array.from({ length: 200 }, (_, index) => String(index))
    const client = await poker.connect()
    await client.query('begin')
    for (const payload of sent)
      await client.query(`select pg_notify('game_changes', $1)`, [payload])
    await client.query('commit')
    client.release()
    await poker.query(`select pg_notify('game_changes', '')`)
    await until(() => games.payloads.length === 201, 'every payload')
    expect(games.payloads).deep.equals([...sent, ''])
    await stopAll()
  })

  it('ends leadership on a failed publish, and comes back when it can', async function () {
    const prefix = testPrefix()
    let failing = false
    const lines: string[] = []
    const makeClient: FeedRelayOptions['makeClient'] = (
      url,
      log,
      name,
      caFile
    ) => {
      const client = makeScoreboardClient(url, log, name, caFile)
      const publish = client.publish.bind(client)
      Object.assign(client, {
        publish: (async (channel: string, message: string) => {
          if (failing) throw new Error('publish refused')
          return await publish(channel, message)
        }) as ScoreboardClient['publish']
      })
      return client
    }
    relayOf(prefix, 'flaky', { makeClient, log: line => lines.push(line) })
    await until(async () => (await backends()) === 1, 'a connection')
    await until(async () => (await leader(prefix)) === 'flaky', 'the lead')
    failing = true
    await until(
      () => lines.some(line => line.includes('publish refused')),
      'the failure'
    )
    await until(async () => (await backends()) === 0, 'the connection closed')
    // Its own name left the key, and an attempt fails until the publish works.
    failing = false
    await until(async () => (await backends()) === 1, 'the lead again')
    await stopAll()
  })

  it('ends leadership when the key no longer names it', async function () {
    const prefix = testPrefix()
    const lines: string[] = []
    relayOf(prefix, 'usurped', { log: line => lines.push(line) })
    await until(async () => (await leader(prefix)) === 'usurped', 'the lead')
    await redis.set(feedLeaderKey(prefix), 'usurper', { PX: 200 })
    await until(
      () => lines.some(line => line.includes('leader key is gone')),
      'the loss'
    )
    await until(async () => (await leader(prefix)) === 'usurped', 'the return')
    await stopAll()
  })

  it('ends leadership when a renewal goes unanswered', async function () {
    const prefix = testPrefix()
    let hanging = false
    const lines: string[] = []
    const makeClient: FeedRelayOptions['makeClient'] = (
      url,
      log,
      name,
      caFile
    ) => {
      const client = makeScoreboardClient(url, log, name, caFile)
      const evaluate = client.eval.bind(client)
      Object.assign(client, {
        eval: async (...args: Parameters<typeof evaluate>) => {
          if (hanging && args[0].includes('pexpire'))
            return await new Promise(() => undefined)
          return await evaluate(...args)
        }
      })
      return client
    }
    relayOf(prefix, 'hung', { makeClient, log: line => lines.push(line) })
    await until(async () => (await leader(prefix)) === 'hung', 'the lead')
    hanging = true
    await until(
      () => lines.some(line => line.includes('unanswered')),
      'the giving up'
    )
    hanging = false
    await stopAll()
  })

  it('ends leadership when its connection stops answering', async function () {
    const prefix = testPrefix()
    const lines: string[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = Client.prototype.query
    relayOf(prefix, 'silent', {
      checkMs: 30,
      checkWaitMs: 100,
      log: line => lines.push(line)
    })
    await until(async () => (await leader(prefix)) === 'silent', 'the lead')
    // Answers come back, then one never does.
    await wait(100)
    expect(lines.some(line => line.includes('went silent'))).equals(false)
    Client.prototype.query = function (
      this: Client,
      ...args: unknown[]
    ): unknown {
      if (args[0] === 'select 1') return new Promise(() => undefined)
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof Client.prototype.query
    try {
      await until(
        () => lines.some(line => line.includes('went silent')),
        'the giving up'
      )
    } finally {
      Client.prototype.query = original
    }
    await stopAll()
  })

  it('leaves when Valkey goes, says so once as a candidate, and leads again when it returns', async function () {
    const prefix = testPrefix()
    const door = await redisDoor()
    const lines: string[] = []
    const feed = feedOf(prefix)
    const games = hearer()
    await feed.subscribe('game_changes', games).listening
    relayOf(
      prefix,
      'outage',
      { log: line => lines.push(line) },
      scratchUrl,
      door.url
    )
    await until(() => games.listenings.length === 2, 'the first resync')
    await door.shut()
    await until(async () => (await backends()) === 0, 'the connection closed')
    await wait(150)
    expect(
      lines.filter(line => line.startsWith('relay candidate')).length
    ).lessThan(3)
    await door.open()
    await until(() => games.listenings.length === 3, 'the second resync')
    await stopAll()
    await door.shut()
  })

  it('delivers without a crash while two leaders overlap', async function () {
    // Two databases, so the lock cannot stop them, each blind to the other's key.
    const prefix = testPrefix()
    const feed = feedOf(prefix)
    const probes = hearer()
    await feed.subscribe('feed_probe', probes).listening
    const lines: string[] = []
    const makeClient: FeedRelayOptions['makeClient'] = (
      url,
      log,
      name,
      caFile
    ) => {
      const client = makeScoreboardClient(url, log, name, caFile)
      Object.assign(client, {
        get: async () => null,
        eval: async () => 1
      })
      return client
    }
    const options: FeedRelayOptions & { log: (line: string) => void } = {
      makeClient,
      log: line => lines.push(line)
    }
    relayOf(prefix, 'here', options, scratchUrl)
    relayOf(prefix, 'there', options, otherUrl)
    await until(
      () => lines.filter(line => line.includes('leads here')).length === 2,
      'both leading'
    )
    await until(() => probes.listenings.length === 3, 'both resyncs')
    await poker.query(`select pg_notify('feed_probe', 'from here')`)
    const other = new Client({ connectionString: otherUrl })
    await other.connect()
    await other.query(`select pg_notify('feed_probe', 'from there')`)
    await other.end()
    await until(() => probes.payloads.length === 2, 'both hints')
    expect(probes.payloads).members(['from here', 'from there'])
    expect(lines.some(line => line.includes('stops leading'))).equals(false)
    await Promise.all(
      running.splice(0).map(async relay => {
        await relay.stop()
      })
    )
    expect(await backends(otherName)).equals(0)
  })

  it('asks Postgres to notice a lost machine, and keeps its own socket alive', async function () {
    const config = relayConnectionConfig(scratchUrl)
    expect(config.application_name).equals(RELAY_APPLICATION_NAME)
    expect(config.keepAlive).equals(true)
    expect(config.keepAliveInitialDelayMillis).greaterThan(0)
    const client = new Client(config)
    await client.connect()
    const show = async (name: string): Promise<string> =>
      (await client.query<Record<string, string>>(`show ${name}`)).rows[0][name]
    expect(await show('tcp_user_timeout')).matches(/^(30000|30s)$/)
    expect(await show('tcp_keepalives_idle')).equals('10')
    expect(await show('tcp_keepalives_interval')).equals('5')
    expect(await show('tcp_keepalives_count')).equals('3')
    await client.end()
  })

  describe('feedProbe', function () {
    const configOf = (
      prefix: string,
      databaseUrl = scratchUrl
    ): Parameters<typeof runFeedProbe>[0] => ({
      databaseUrl,
      databasePoolUrl: '',
      redis: { url: testRedisUrl, prefix, caFile: '' }
    })

    it('exits 0 on an echo, printing the round trip and the leader', async function () {
      const prefix = testPrefix()
      relayOf(prefix, '42@probe.example.test')
      await until(
        async () => (await leader(prefix)) != null && (await backends()) === 1,
        'a leader'
      )
      await wait(50)
      const printed: string[] = []
      const code = await runFeedProbe(configOf(prefix), {
        print: line => printed.push(line)
      })
      expect(code).equals(0)
      expect(printed.join('\n')).matches(
        /round trip \d+ ms; leader 42@probe\.example\.test/
      )
      await stopAll()
    })

    it('runs as a command, reading the config where it stands', async function () {
      const prefix = testPrefix()
      relayOf(prefix, '42@probe.example.test')
      await until(async () => (await backends()) === 1, 'a leader')
      await wait(50)
      const dir = mkdtempSync(join(tmpdir(), 'feed-probe-'))
      try {
        writeFileSync(
          join(dir, 'serverConfig.json'),
          JSON.stringify(configOf(prefix))
        )
        const { stdout } = await run(
          process.execPath,
          [
            '-r',
            require.resolve('sucrase/register'),
            join(__dirname, 'probeCli.ts')
          ],
          { cwd: dir }
        )
        expect(stdout).matches(/round trip \d+ ms; leader 42@probe/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      await stopAll()
    })

    it('exits non-zero on silence', async function () {
      const printed: string[] = []
      const code = await runFeedProbe(configOf(testPrefix()), {
        print: line => printed.push(line),
        timeoutMs: 200
      })
      expect(code).equals(1)
      expect(printed.join('\n')).includes(
        'no echo within 200 ms; leader (none)'
      )
    })

    it('exits non-zero when the database cannot be reached', async function () {
      const printed: string[] = []
      const code = await runFeedProbe(
        configOf(
          testPrefix(),
          scratchUrl.replace(/\/[^/]*$/, '/teamstation_relay_nowhere')
        ),
        { print: line => printed.push(line), timeoutMs: 200 }
      )
      expect(code).equals(1)
      expect(printed.join('\n')).includes('the probe failed')
    })
  })
})
