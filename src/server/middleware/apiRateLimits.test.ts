import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { expect } from 'chai'
import type { Request, Response as ExpressResponse } from 'express'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { parseEvent, type Property } from '../../common/observability/contract'
import { readerHeaders } from '../graphql/restReader'
import { rateMetrics } from '../observability/apiRateMetrics'
import type { ScoreboardClient } from '../scoreboard/scoreboardStore'
import { apiCall, credentialsOf } from '../tess/loopback'
import { localBudgets, sharedBudgets } from '../valkey/apiBudgets'
import {
  apiCost,
  apiRateLimits,
  type Bucket,
  CONFIRM_REFILL_SECONDS,
  OBSERVE_PARENT_HEADER,
  type Spend,
  type SpendResult
} from './apiRateLimits'

describe('API traffic budgets', () => {
  it('charges the same tier across IDs, case and trailing slashes and keeps media polls affordable', () => {
    for (const [verb, path, cost] of [
      ['GET', '/time', 'ordinary'],
      ['GET', '/videos/one/hls/list.m3u8', 'ordinary'],
      ['GET', '/videos/two/wall-timeline', 'ordinary'],
      ['HEAD', '/Me/Home/', 'aggregate'],
      ['GET', '/teams/abc', 'aggregate'],
      ['GET', '/teams/abc/roster', 'aggregate'],
      ['GET', '/events/abc/info', 'aggregate'],
      ['GET', '/events', 'aggregate'],
      ['GET', '/chat/conversations', 'aggregate'],
      ['PUT', '/groups/team/abc', 'aggregate'],
      ['GET', '/teams/abc/games/', 'aggregate'],
      ['POST', '/TEAMS/other/GAMES', 'expensive'],
      ['POST', '/graphql', 'expensive'],
      ['POST', '/admin/analytics/query', 'expensive'],
      ['PUT', '/leagues/one/umpires', 'expensive'],
      ['GET', '/leagues/one/umpires', 'aggregate'],
      ['DELETE', '/me/account', 'expensive'],
      ['DELETE', '/videos/two', 'expensive'],
      ['POST', '/director/uploads/one/finish', 'expensive'],
      ['POST', '/leagues/one/sponsors/media', 'expensive'],
      ['GET', '/leagues/one/sponsors', 'ordinary'],
      ['PUT', '/Node/Sponsor-Sample/', 'expensive'],
      ['GET', '/leagues/one/schedule-previews/latest', 'expensive'],
      ['POST', '/me/tess/changes/one/confirm', 'expensive'],
      ['GET', '/anything-new', 'ordinary']
    ])
      expect(apiCost(verb, path), path).equals(cost)
  })

  it('limits one account across networks and leaves another account and cheaper work available', async () => {
    let now = 0
    const limits = apiRateLimits(
      localBudgets(() => now),
      'enforce'
    )
    for (let i = 0; i < 8; ++i)
      expect(await limits.request('192.0.2.1', 'one', 'expensive')).equals(0)
    expect(await limits.request('192.0.2.2', 'one', 'expensive')).equals(3)
    expect(await limits.request('192.0.2.1', 'two', 'expensive')).equals(0)
    expect(await limits.request('192.0.2.1', 'one', 'ordinary')).equals(0)
    now += 2999
    expect(await limits.request(null, 'one', 'expensive')).equals(1)
    now++
    expect(await limits.request(null, 'one', 'expensive')).equals(0)
  })

  it('shares guest IPv6 prefixes and mapped IPv4; malformed addresses share one allowance', async () => {
    for (const [a, b] of [
      ['2001:db8::1', '2001:db8::2'],
      ['::ffff:c000:201', '192.0.2.1'],
      ['bad', undefined]
    ]) {
      const limits = apiRateLimits(
        localBudgets(() => 0),
        'enforce'
      )
      for (let i = 0; i < 4; i++)
        expect(await limits.request(a, undefined, 'expensive')).equals(0)
      expect(await limits.request(b, undefined, 'expensive')).equals(10)
      expect(
        await limits.request('198.51.100.2', undefined, 'expensive')
      ).equals(0)
    }
  })

  it('allows 32 guest aggregate reads after idle and refills one every 400 milliseconds', async () => {
    let now = 0
    const limits = apiRateLimits(
      localBudgets(() => now),
      'enforce'
    )
    const guest = async (): Promise<number> =>
      await limits.request('192.0.2.1', undefined, 'aggregate')
    for (let i = 0; i < 32; i++) expect(await guest()).equals(0)
    expect(await guest()).equals(1)
    now = 399
    expect(await guest()).equals(1)
    now = 400
    expect(await guest()).equals(0)
    expect(await guest()).equals(1)
  })

  it('enforces a shared network limit across accounts and charges no other bucket on a refusal', async () => {
    const limits = apiRateLimits(
      localBudgets(() => 0),
      'enforce'
    )
    for (let i = 0; i < 64; i++)
      expect(await limits.request('192.0.2.1', String(i), 'expensive')).equals(
        0
      )
    for (let i = 0; i < 16; i++)
      expect(await limits.request('192.0.2.1', 'other', 'expensive')).equals(1)
    expect(await limits.request('192.0.2.2', 'other', 'expensive')).equals(0)
  })

  it('caps fallback memory and reclaims idle entries without dropping active identities', async () => {
    let now = 0
    const spend = localBudgets(() => now, 1)
    const bucket = (key: string): Bucket[] => [
      { key, budget: [1500, 1], scope: 'account', tier: 'ordinary' }
    ]
    expect((await spend(bucket('first'))).retryAfterSec).equals(0)
    expect((await spend(bucket('second'))).retryAfterSec).equals(1)
    now = 1100
    expect((await spend(bucket('first'))).retryAfterSec).equals(1)
    now = 2100
    expect((await spend(bucket('second'))).retryAfterSec).equals(0)
  })

  it('uses the shared script, handles cache misses, and enforces a local limit during an outage', async () => {
    const client = Object.assign(new EventEmitter(), {
      isReady: true,
      isOpen: true,
      evalSha: async () => {
        throw new Error('NOSCRIPT absent')
      },
      eval: async (_script: string, opts: { keys: string[] }) =>
        opts.keys[0].includes(':probe:') ? [0, 0] : [2, 1]
    })
    const logs: string[] = []
    const store = sharedBudgets(
      client as unknown as ScoreboardClient,
      'fixture',
      'enforce',
      m => logs.push(m)
    )
    const { spend } = store
    const buckets: Bucket[] = [
      { key: 'x', budget: [3000, 1], scope: 'account', tier: 'ordinary' }
    ]
    expect(await spend(buckets)).deep.equals({
      backend: 'shared',
      retryAfterSec: 2,
      limiting: 0
    })
    client.evalSha = async () => {
      throw new Error('offline')
    }
    expect(await spend(buckets)).deep.equals({
      backend: 'local',
      retryAfterSec: 0,
      limiting: -1,
      error: 'unavailable'
    })
    client.isReady = false
    expect((await spend(buckets)).retryAfterSec).equals(3)
    expect(logs.filter(line => line.includes('local allowance'))).has.length(1)
    store.close()
  })

  it('probes the writer before callers, classifies configuration and transient faults, and never replays uncertain debits', async () => {
    const b: Bucket[] = [
      {
        key: 'account:fixture',
        budget: [3000, 1],
        tier: 'ordinary',
        scope: 'account'
      }
    ]
    for (const [message, fault] of [
      ['CROSSSLOT keys', 'cluster'],
      ['MOVED 42 private-target', 'cluster'],
      ['NOPERM private-key', 'permissions'],
      ['ERR ACL failure in script', 'permissions'],
      ['READONLY replica', 'readOnly'],
      ['WRONGTYPE private-key', 'storeError'],
      ['ECONNRESET private-target', 'unavailable']
    ]) {
      let written = 0
      let issue = ''
      const logs: string[] = []
      const seen: string[][] = []
      const client = Object.assign(new EventEmitter(), {
        isReady: true,
        isOpen: true,
        evalSha: async (_sha: string, opts: { keys: string[] }) => {
          seen.push(opts.keys)
          if (issue !== '') throw new Error(issue)
          if (!opts.keys[0].includes(':probe:')) written++
          return [0, 0]
        }
      })
      const store = sharedBudgets(
        client as unknown as ScoreboardClient,
        'fixture',
        'enforce',
        m => logs.push(m)
      )
      try {
        expect((await store.spend(b)).backend).equals('shared')
        expect(seen[0]).has.length(11)
        expect(seen[0].every(key => key.includes(':probe:'))).equals(true)
        expect(store.health().readiness).equals('ready')
        issue = message
        const before = seen.length
        expect(await store.spend(b)).includes({
          backend: 'local',
          error: fault,
          retryAfterSec: 0
        })
        expect(await store.spend(b)).includes({
          backend: 'local',
          retryAfterSec: 3
        })
        expect(seen.length - before).equals(1)
        expect(store.health()).includes({
          fault,
          readiness: fault === 'unavailable' ? 'degraded' : 'failed'
        })
        expect(logs.join(' ')).not.includes('private-')
        issue = ''
        client.emit('ready')
        expect((await store.spend(b)).backend).equals('shared')
        expect(store.health().readiness).equals('ready')
        expect(written).equals(2)
      } finally {
        store.close()
      }
    }
    const client = Object.assign(new EventEmitter(), {
      isReady: true,
      isOpen: true
    })
    const off = sharedBudgets(
      client as unknown as ScoreboardClient,
      'fixture',
      'off',
      () => {}
    )
    expect(off.health()).deep.equals({
      mode: 'off',
      readiness: 'off',
      degradedMs: 0
    })
    expect(client.listenerCount('ready')).equals(0)
    off.close()
  })

  it('uses the first shared decision when the writer finishes connecting during startup', async () => {
    const client = Object.assign(new EventEmitter(), {
      isReady: false,
      isOpen: true,
      evalSha: async () => [0, 0]
    })
    const store = sharedBudgets(
      client as unknown as ScoreboardClient,
      'fixture',
      'enforce',
      () => {}
    )
    try {
      const first = store.spend([
        { key: 'test', budget: [3000, 1], scope: 'account', tier: 'ordinary' }
      ])
      client.isReady = true
      client.emit('ready')
      expect((await first).backend).equals('shared')
      expect(store.health().readiness).equals('ready')
    } finally {
      store.close()
    }
  })

  it('keeps an old probe from clearing a newer fault and verifies recovery before using the writer', async () => {
    let complete: (reply: number[]) => void = () => {}
    let attempts = 0
    const client = Object.assign(new EventEmitter(), {
      isReady: false,
      isOpen: false,
      evalSha: async () => {
        if (++attempts === 1)
          return await new Promise<number[]>(resolve => {
            complete = resolve
          })
        return attempts === 2 ? [1, 1] : [0, 0]
      }
    })
    const logs: string[] = []
    const store = sharedBudgets(
      client as unknown as ScoreboardClient,
      'fixture',
      'observe',
      line => logs.push(line)
    )
    const b: Bucket[] = [
      { key: 'test', budget: [3000, 1], scope: 'account', tier: 'ordinary' }
    ]
    try {
      expect(store.health().readiness).equals('checking')
      expect((await store.spend(b)).error).equals('unavailable')
      client.isOpen = true
      client.isReady = true
      client.emit('ready')
      client.emit('ready')
      await new Promise(resolve => setImmediate(resolve))
      expect(attempts).equals(1)
      client.isReady = false
      client.emit('error', new Error('WRONGPASS private-fixture'))
      complete([0, 0])
      expect((await store.spend(b)).error).equals('permissions')
      client.isReady = true
      client.emit('ready')
      expect((await store.spend(b)).error).equals('storeError')
      client.emit('ready')
      expect((await store.spend(b)).backend).equals('shared')
      client.isReady = false
      expect((await store.spend(b)).error).equals('unavailable')
      expect(logs.join(' ')).not.includes('private-fixture')
    } finally {
      store.close()
    }
  })

  it('does not submit a new write for a cache miss reported after the command deadline', async () => {
    let lateMiss = (): void => {}
    let loads = 0
    const client = Object.assign(new EventEmitter(), {
      isReady: true,
      isOpen: true,
      evalSha: async (_sha: string, opts: { keys: string[] }) => {
        if (opts.keys[0].includes(':probe:')) return [0, 0]
        return await new Promise<number[]>((_resolve, reject) => {
          lateMiss = () => {
            reject(new Error('NOSCRIPT delayed'))
          }
        })
      },
      eval: async () => {
        ++loads
        return [0, 0]
      }
    })
    const store = sharedBudgets(
      client as unknown as ScoreboardClient,
      'fixture',
      'enforce',
      () => {}
    )
    try {
      const result = await store.spend([
        { key: 'test', budget: [3000, 1], scope: 'account', tier: 'ordinary' }
      ])
      expect(result).includes({ backend: 'local', error: 'timeout' })
      lateMiss()
      await new Promise(resolve => setImmediate(resolve))
      expect(loads).equals(0)
    } finally {
      store.close()
    }
  })

  it('uses one local decision after a timed-out shared write, without sending it a second time', async () => {
    let sent = 0
    const client = Object.assign(new EventEmitter(), {
      isReady: true,
      isOpen: true,
      evalSha: async (_sha: string, opts: { keys: string[] }) => {
        if (opts.keys[0].includes(':probe:')) return [0, 0]
        ++sent // The primary applied the write. Its answer never arrives.
        return await new Promise<number[]>(() => {})
      }
    })
    const store = sharedBudgets(
      client as unknown as ScoreboardClient,
      'fixture',
      'enforce',
      () => {}
    )
    try {
      const b: Bucket[] = [
        {
          key: 'account:one',
          scope: 'account',
          tier: 'ordinary',
          budget: [3000, 1]
        }
      ]
      expect(await store.spend(b)).includes({
        backend: 'local',
        retryAfterSec: 0,
        error: 'timeout'
      })
      expect(await store.spend(b)).includes({
        backend: 'local',
        retryAfterSec: 3,
        error: 'timeout'
      })
      expect(sent).equals(1)
    } finally {
      store.close()
    }
  })

  it('admits a three-game offline refresh and the home screen as one burst', async () => {
    const limits = apiRateLimits(
      localBudgets(() => 0),
      'enforce'
    )
    const paths = [
      '/me/home',
      '/me/roles',
      '/me/groups',
      '/me/offline-scoring',
      '/me/notifications/summary'
    ]
    for (let game = 0; game < 3; game++) {
      paths.push(
        `/games/${game}`,
        `/games/${game}/lineups`,
        `/games/${game}/events`,
        `/events/${game}/info`,
        `/games/${game}/plans`,
        `/games/${game}/box-score`
      )
      for (const side of ['home', 'away']) {
        const team = `/teams/${side}-${game}`
        paths.push(team + '/roster', team + '/roster', team + '/default-lineup')
      }
    }
    for (const path of paths)
      expect(
        await limits.request('192.0.2.1', 'reader', apiCost('GET', path)),
        path
      ).equals(0)
  })

  it('budgets a schedule import by its rows, after the body and account are known', async () => {
    let now = 0
    const limits = apiRateLimits(
      localBudgets(() => now),
      'enforce'
    )
    let retrySeconds = 0
    const res = {
      set: (key: string, value: string) => {
        if (key === 'Retry-After') retrySeconds = Number(value)
      }
    } as unknown as ExpressResponse
    const importRows = async (
      userId: string | undefined,
      games: unknown
    ): Promise<number> =>
      await new Promise(resolve => {
        const req = {
          body: { games },
          actor: userId == null ? undefined : { userId },
          ip: '192.0.2.1'
        }
        limits.scheduleBatch(
          req as unknown as Request,
          res,
          (error?: unknown) => {
            resolve(error instanceof HttpError ? error.status : 200)
          }
        )
      })
    for (const rows of [null, [], Array(201)])
      expect(await importRows('one', rows)).equals(200)
    expect(await importRows(undefined, Array(200))).equals(200)
    expect(await importRows('one', Array(200))).equals(200)
    expect(await importRows('one', Array(1))).equals(429)
    expect(await importRows('two', Array(200))).equals(200)
    expect(await importRows('three', Array(1))).equals(429)
    now += 1000
    expect(await importRows('one', Array(1))).equals(200)
    expect(await importRows('one', Array(200))).equals(429)
    expect(retrySeconds).equals(200)
    now += (retrySeconds + CONFIRM_REFILL_SECONDS) * 1000
    for (const path of ['/me/tess/changes/confirm', '/teams/demo/games'])
      expect(
        await limits.request('192.0.2.1', 'one', apiCost('POST', path))
      ).equals(0)
    expect(await importRows('one', Array(200))).equals(200)
  })

  it('refills enough for a Tess confirmation and its inner import on an exhausted account', async () => {
    let now = 0
    const limits = apiRateLimits(
      localBudgets(() => now),
      'enforce'
    )
    const post = async (path: string): Promise<number> =>
      await limits.request('192.0.2.4', 'reader', apiCost('POST', path))
    for (let i = 0; i < 7; i++)
      expect(await post('/teams/demo/games')).equals(0)
    expect(await post('/me/tess/changes/confirm')).equals(0)
    const wait = await post('/teams/demo/games')
    expect(wait).equals(3)
    now += (wait + CONFIRM_REFILL_SECONDS) * 1000
    expect(await post('/me/tess/changes/confirm')).equals(0)
    expect(await post('/teams/demo/games')).equals(0)
  })

  it('sends the standard retry signal and admits work after refill', async () => {
    const calls: Bucket[][] = []
    const limits = apiRateLimits(async b => {
      calls.push(b)
      return {
        backend: 'shared',
        retryAfterSec: calls.length === 1 ? 0 : 3,
        limiting: calls.length === 1 ? -1 : 1
      }
    }, 'enforce')
    const req = {
      path: '/graphql',
      method: 'POST',
      ip: '192.0.2.1',
      actor: { userId: 'one' }
    } as unknown as Request
    const headers = new Map<string, string>()
    const res = {
      set: (k: string, v: string) => headers.set(k, v)
    } as unknown as ExpressResponse
    const run = async (
      handler: typeof limits.beforeAuth
    ): Promise<HttpError | undefined> =>
      await new Promise<HttpError | undefined>(resolve =>
        handler(req, res, (err?: unknown) => {
          resolve(err instanceof HttpError ? err : undefined)
        })
      )
    expect(await run(limits.beforeAuth)).equals(undefined)
    const error = await run(limits.afterAuth)
    expect(error?.status).equals(429)
    expect(error?.details).deep.equals({ retryAfterSec: 3 })
    expect(headers.get('Retry-After')).equals('3')
    expect(calls.flat().map(b => b.key)).deep.equals([
      'ip:192.0.2.1',
      'account:one',
      'account:one:expensive',
      'ip:192.0.2.1:expensive'
    ])
  })
  it('chooses the largest unrounded excess, breaking exact ties by bucket order', async () => {
    const spend = localBudgets(() => 0)
    const b: Bucket = {
      key: 'one',
      budget: [250, 1],
      scope: 'account',
      tier: 'ordinary'
    }
    const c: Bucket = {
      ...b,
      key: 'two',
      scope: 'signedInIp',
      tier: 'aggregate'
    }
    await spend([b, c])
    expect(await spend([b, c])).deep.equals({
      retryAfterSec: 1,
      limiting: 0,
      backend: 'local'
    })
    expect(await spend([b, { ...c, units: 2 }])).deep.equals({
      retryAfterSec: 1,
      limiting: 1,
      backend: 'local'
    })
  })

  it('stops shadow charging an HTTP request at the same first gate as enforcement', async () => {
    for (const refuseAt of [0, 1, 2, 3]) {
      for (const mode of ['off', 'observe', 'enforce'] as const) {
        const req = {
          ip: '192.0.2.8',
          actor: { userId: 'fixture' },
          method: 'POST',
          path: '/teams/fixture/games',
          body: { games: Array(10) }
        } as unknown as Request
        const res = { set: () => undefined } as unknown as ExpressResponse
        const charges: string[] = []
        const decisions: string[] = []
        const limits = apiRateLimits(
          async buckets => {
            charges.push(buckets.at(-1)!.tier)
            const refused = charges.length === refuseAt
            return {
              retryAfterSec: refused ? 5 : 0,
              limiting: refused ? 0 : -1,
              backend: 'shared'
            }
          },
          mode,
          {
            missedUpgradeIdentity: () => undefined,
            record: (_, tier, transport, result) => {
              if (result.retryAfterSec > 0)
                decisions.push(transport + '/' + tier)
            }
          }
        )
        let status = 200
        for (const handler of [
          limits.beforeAuth,
          limits.afterAuth,
          limits.scheduleBatch
        ]) {
          const error = await new Promise<unknown>(resolve =>
            handler(req, res, resolve)
          )
          if (error instanceof HttpError) {
            status = error.status
            break
          }
        }
        const tiers = ['arrival', 'expensive', 'rows']
        expect(charges).deep.equals(
          mode === 'off' ? [] : tiers.slice(0, refuseAt === 0 ? 3 : refuseAt)
        )
        expect(decisions).deep.equals(
          mode === 'off' || refuseAt === 0
            ? []
            : ['http/' + tiers[refuseAt - 1]]
        )
        expect(status).equals(mode === 'enforce' && refuseAt > 0 ? 429 : 200)
      }
    }
  })

  it('carries a refused parent across trusted GraphQL and Tess calls only in observe', async () => {
    const key = randomUUID()
    let debits = 0
    const spend = async (): Promise<SpendResult> => {
      debits++
      return { backend: 'local' as const, limiting: 0, retryAfterSec: 1 }
    }
    const originIp = '192.0.2.15'
    const request = (
      ip: string,
      headers: Record<string, string> = {}
    ): Request =>
      ({
        ip,
        headers,
        header: (name: string) => headers[name]
      }) as unknown as Request
    const res = { set: () => undefined } as unknown as ExpressResponse
    const run = async (
      mode: 'observe' | 'enforce',
      req: Request
    ): Promise<unknown> =>
      await new Promise(resolve =>
        apiRateLimits(spend, mode, undefined, key).beforeAuth(req, res, resolve)
      )
    const parent = request(originIp)
    await run('observe', parent)
    const proof = readerHeaders(parent)[OBSERVE_PARENT_HEADER]
    expect(proof).to.be.a('string')
    const nested = request(originIp, { [OBSERVE_PARENT_HEADER]: proof })
    await run('observe', nested)
    expect(debits).equals(1)
    let sent: Record<string, string> = {}
    await apiCall(
      'https://fixture.invalid',
      credentialsOf(nested),
      'GET',
      '/teams',
      undefined,
      undefined,
      {
        fetch: async (_input, init) => {
          sent = init?.headers as Record<string, string>
          return Response.json([])
        }
      }
    )
    await run('observe', request(originIp, sent))
    expect(debits).equals(1)
    await run('observe', request('192.0.2.16', sent))
    await run(
      'observe',
      request(originIp, { [OBSERVE_PARENT_HEADER]: 'invalid' })
    )
    await run('enforce', request(originIp, sent))
    expect(debits).equals(4)
  })

  it('preserves the virtual lifetime of a shadow-refused search connection', async () => {
    for (const mode of ['off', 'observe', 'enforce'] as const) {
      for (const blockedAt of [1, 2, 3]) {
        let calls = 0
        let lookups = 0
        const socket = {}
        const limits = apiRateLimits(async () => {
          const refused = ++calls === blockedAt
          return {
            backend: 'shared',
            limiting: refused ? 0 : -1,
            retryAfterSec: refused ? 1 : 0
          }
        }, mode)
        let wait = await limits.upgrade(socket, '192.0.2.8', async () => {
          lookups++
          return 'fixture'
        })
        expect(lookups).equals(mode === 'off' || blockedAt === 1 ? 0 : 1)
        for (let n = 0; n < 3 && wait === 0; n++)
          wait = await limits.request(
            '192.0.2.8',
            'fixture',
            'aggregate',
            'search',
            socket
          )
        expect(calls).equals(mode === 'off' ? 0 : blockedAt)
        expect(wait).equals(mode === 'enforce' ? 1 : 0)
        expect(await limits.request('192.0.2.8', 'fixture', 'ordinary')).equals(
          0
        )
        expect(calls).equals(mode === 'off' ? 0 : blockedAt + 1)
      }
    }
  })

  it('allows a public upgrade when shadow identity is unavailable and counts misses without recording the exception', async () => {
    const reports: Array<[string, unknown]> = []
    const metrics = rateMetrics('observe', (name, fields) => {
      reports.push([name, fields])
    })
    const calls: string[] = []
    const spend: Spend = async buckets => {
      calls.push(buckets[0].tier)
      return { backend: 'shared', limiting: -1, retryAfterSec: 0 }
    }
    const lookup = async (): Promise<string> => {
      throw new Error('private lookup detail')
    }
    const observe = apiRateLimits(spend, 'observe', metrics)
    expect(await observe.upgrade({}, '192.0.2.1', lookup)).equals(0)
    expect(await observe.upgrade({}, '192.0.2.1', lookup)).equals(0)
    expect(calls).deep.equals(['arrival', 'arrival'])
    metrics.flush()
    metrics.flush()
    expect(
      reports.filter(([name]) => name === 'api_rate_upgrade_identity_missed')
    ).deep.equals([['api_rate_upgrade_identity_missed', { n: 2 }]])
    expect(JSON.stringify(reports)).not.to.include('private lookup detail')
    const enforce = apiRateLimits(spend, 'enforce', metrics)
    const error = await enforce
      .upgrade({}, '192.0.2.1', lookup)
      .catch((err: unknown) => (err instanceof Error ? err.message : undefined))
    expect(error).equals('private lookup detail')
  })

  it('reports bounded decisions, demand peaks and degraded time without principal labels', () => {
    let clock = 0
    const output: Array<{ event: string; props: Record<string, Property> }> = []
    const m = rateMetrics(
      'observe',
      (event, props) => {
        parseEvent({
          A: 'TS srv',
          E: event,
          L: 'info',
          R: 1,
          D: new Date().toISOString(),
          I: randomUUID(),
          P: props
        })
        output.push({ event, props })
      },
      () => clock
    )
    const result = {
      retryAfterSec: 0,
      limiting: -1,
      backend: 'shared'
    } as const
    const b: Bucket = {
      key: 'private-fixture',
      scope: 'account',
      tier: 'rows',
      budget: [1000, 200],
      units: 10
    }
    // Enough distinct synthetic keys to exercise the bounded sample and cap.
    const buckets = Array.from({ length: 12000 }, (_, i) => ({
      ...b,
      key: b.key + i
    }))
    for (const elapsed of [1, 5, 20, 100, 101]) {
      clock += 1000
      for (const bucket of buckets)
        m.record([bucket], 'rows', 'http', result, elapsed)
    }
    m.record(
      [b],
      'rows',
      'http',
      { backend: 'local', retryAfterSec: 3, limiting: 0, error: 'unavailable' },
      1
    )
    m.storeDegraded(true)
    clock += 250
    m.flush()
    const admitted = output.find(
      x => x.event === 'api_rate_decisions' && x.props.backend === 'shared'
    )!.props
    expect(admitted).includes({
      scope: 'account',
      tier: 'rows',
      mode: 'observe',
      transport: 'http',
      n: 60000,
      units: 600000,
      admittedUnits: 600000,
      le1: 12000,
      le5: 24000,
      le20: 36000,
      le100: 48000
    })
    expect(
      output
        .filter(x => x.event === 'api_rate_demand')
        .map(x => [x.props.windowSec, x.props.p95])
    ).deep.equals([
      [1, 10],
      [10, 50],
      [60, 50]
    ])
    expect(output.at(-1)?.props.n).equals(1024)
    expect(output.some(x => x.props.degradedMs === 250)).equals(true)
    expect(output.find(x => x.props.fault === 'unavailable')?.props).includes({
      decision: 'refused',
      admittedUnits: 0,
      units: 10,
      limitingTier: 'rows'
    })
    clock += 100
    m.storeDegraded(false)
    m.record([b], 'rows', 'http', result, 1)
    m.flush()
    expect(output.some(x => x.props.degradedMs === 100)).equals(true)
    expect(JSON.stringify(output)).not.includes(b.key)
  })
})
