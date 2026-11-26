import { isIP } from 'node:net'

import type { Request, RequestHandler } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'

import { rateLimited } from '../../common/errors'
import { SCHEDULE_GAMES_MAX } from '../../common/scheduleGames'
import { signQueryToken, verifyQueryToken } from '../media/mediaTokens'
import type { RateMetrics } from '../observability/apiRateMetrics'
import type { ServerConfig } from '../serverConfigSchema'
import { withAsync } from './withErrors'

export type ApiCost = 'ordinary' | 'aggregate' | 'expensive'

// Rolling admission budgets: milliseconds to earn one request and how many
// requests an idle caller can make immediately. A tier is shared across paths.
type Budget = readonly [intervalMs: number, burst: number]
export type RateMode = ServerConfig['apiRateLimitMode']
export type RateTier = ApiCost | 'arrival' | 'rows'
export type RateScope = 'arrivalIp' | 'guestIp' | 'signedInIp' | 'account'
export type Transport = 'http' | 'upgrade' | 'search'
export interface Bucket {
  key: string
  budget: Budget
  scope: RateScope
  tier: RateTier
  units?: number
}
export type StoreFault =
  | 'unavailable'
  | 'timeout'
  | 'permissions'
  | 'readOnly'
  | 'cluster'
  | 'storeError'
export interface SpendResult {
  retryAfterSec: number
  limiting: number // Zero-based position in the gate, or -1 for admission/store capacity.
  backend: 'shared' | 'local'
  error?: StoreFault
}
export type Spend = (buckets: Bucket[]) => Promise<SpendResult>

const ingress: Budget = [10, 1500]
const account = {
  ordinary: [100, 180],
  aggregate: [400, 48],
  expensive: [3000, 8]
} as const
// Confirming a Tess proposal consumes an expensive operation before the inner
// write can spend its own unit. Allow both units to refill for a retry.
export const CONFIRM_REFILL_SECONDS = Math.ceil(account.expensive[0] / 1000)
const guest = {
  ordinary: [250, 100],
  aggregate: [400, 32],
  expensive: [10000, 4]
} as const
const network = { aggregate: [40, 360], expensive: [250, 64] } as const

// Match the same case and optional terminal slash as the Express routers.
// Only literal route segments select a tariff; IDs and query strings never
// create a new allowance. HEAD runs the same handler as GET.
export function apiCost(method: string, path: string): ApiCost {
  const p = path.toLowerCase().replace(/\/$/, '')
  if (
    p === '/graphql' ||
    /^\/players\/[^/]+\/highlights$/.test(p) ||
    p === '/admin/analytics/query' ||
    /^\/me\/tess\/(messages|changes\/([^/]+\/)?confirm)$/.test(p) ||
    /^\/(leagues\/[^/]+\/schedule-previews|schedule-previews)(\/|$)/.test(p) ||
    (method === 'POST' && /^\/teams\/[^/]+\/games$/.test(p)) ||
    (method === 'DELETE' &&
      (p === '/me/account' || /^\/videos\/[^/]+$/.test(p))) ||
    (method === 'POST' && /^\/director\/uploads\/[^/]+\/finish$/.test(p)) ||
    (method !== 'GET' &&
      method !== 'HEAD' &&
      /^\/(node\/ownership-preflight|leagues\/[^/]+\/(umpire-settings|umpire-requirements|umpire-season-priority|umpires))$/.test(
        p
      ))
  )
    return 'expensive'

  if (
    /^\/(teams|leagues|seasons|events|users|venues|live|locations|location-suggestions|openapi\.json)$/.test(
      p
    ) ||
    /^\/(teams|leagues|seasons|games|players)\/[^/]+$/.test(p) ||
    /^\/me\/(home|offline-scoring|groups|roles|affiliations|notifications(\/summary)?)$/.test(
      p
    ) ||
    /^\/(teams|seasons|leagues|players|games|videos)\/[^/]+\/(stats|standings|highlights|plays|teams|people|games|roster|schedule|schedule-setup|umpire-schedule|umpire-leaderboard|games-to-reschedule|umpire-candidates|umpires|roster-players|default-lineup|box-score|events|halves|lineups|plans|line-score|scoreboard-timeline|narrations)(\/|$)/.test(
      p
    ) ||
    /^\/events\/[^/]+\/info$/.test(p) ||
    /^\/chat\/(conversations|dm-candidates|dm-reach|dm-proxies|included-adults)$/.test(
      p
    ) ||
    /^\/(groups|game-requests|manage|parent-previews|parent-links|relationship-requests)(\/|$)/.test(
      p
    )
  )
    return 'aggregate'
  return 'ordinary'
}

function ipKey(ip: string | null | undefined): string {
  return ip != null && isIP(ip) !== 0 ? ipKeyGenerator(ip, 64) : 'unknown'
}

type Address = string | null | undefined
export interface ApiRateLimits {
  request: (
    ip: Address,
    userId: string | undefined,
    cost: ApiCost,
    transport?: Transport,
    context?: object
  ) => Promise<number>
  upgrade: (
    socket: object,
    ip: Address,
    identify?: () => Promise<string | undefined>
  ) => Promise<number>
  beforeAuth: RequestHandler
  afterAuth: RequestHandler
  scheduleBatch: RequestHandler
}

// A loopback writer can retry only when admission refused it before the handler.
export const API_ADMISSION_HEADER = 'x-teamstation-api-admission'

// A verified observation-only decision can cross a worker boundary on server-owned
// loopback calls. Mint a short-lived proof when dispatching, including for a long Tess turn.
export const OBSERVE_PARENT_HEADER = 'x-teamstation-observe-parent'
const observedParents = new WeakMap<object, () => string>()
export function observedParent(req: Request): (() => string) | undefined {
  return observedParents.get(req)
}

export function apiRateLimits(
  spend: Spend,
  mode: RateMode,
  metrics?: RateMetrics,
  loopbackKey?: string
): ApiRateLimits {
  // A request is one HTTP operation. For search, the same socket object spans
  // its handshake and every executed search until the physical connection ends.
  const shadowStopped = new WeakSet<object>()
  const bypass = (context?: object): boolean =>
    mode === 'off' || (context != null && shadowStopped.has(context))

  const charge = async (
    buckets: Bucket[],
    tier: RateTier,
    transport: Transport,
    context?: object
  ): Promise<number> => {
    const start = performance.now()
    const result = await spend(buckets)
    metrics?.record(buckets, tier, transport, result, performance.now() - start)
    if (mode === 'observe' && result.retryAfterSec > 0) {
      if (context != null) shadowStopped.add(context)
      return 0
    }
    return result.retryAfterSec
  }

  const arrival = async (
    ip: Address,
    transport: Transport,
    context: object
  ): Promise<number> => {
    if (bypass(context)) return 0
    return await charge(
      [
        {
          key: 'ip:' + ipKey(ip),
          budget: ingress,
          scope: 'arrivalIp',
          tier: 'arrival'
        }
      ],
      'arrival',
      transport,
      context
    )
  }

  const request = async (
    ip: Address,
    userId: string | undefined,
    cost: ApiCost,
    transport: Transport = 'http',
    context?: object
  ): Promise<number> => {
    if (bypass(context)) return 0
    const address = ipKey(ip)
    const owner = userId == null ? 'guest:' + address : 'account:' + userId
    const rates = userId == null ? guest : account
    const scope = userId == null ? 'guestIp' : 'account'
    const buckets: Bucket[] = [
      { key: owner, budget: rates.ordinary, scope, tier: 'ordinary' }
    ]
    if (cost !== 'ordinary') {
      buckets.push({
        key: owner + ':' + cost,
        budget: rates[cost],
        scope,
        tier: cost
      })
      if (userId != null)
        buckets.push({
          key: 'ip:' + address + ':' + cost,
          budget: network[cost],
          scope: 'signedInIp',
          tier: cost
        })
    }
    return await charge(buckets, cost, transport, context)
  }

  const gate = (check: (req: Request) => Promise<number>): RequestHandler =>
    withAsync(async (req, res, next) => {
      const wait = bypass(req) ? 0 : await check(req)
      if (
        loopbackKey != null &&
        shadowStopped.has(req) &&
        !observedParents.has(req)
      ) {
        const subject = ipKey(req.ip)
        observedParents.set(req, () =>
          signQueryToken(loopbackKey, subject, Date.now(), 60)
        )
      }
      if (wait === 0) {
        next()
        return
      }
      res.set(API_ADMISSION_HEADER, 'refused')
      res.set('Retry-After', String(wait))
      res.set('Cache-Control', 'no-store')
      next(rateLimited('Too many requests. Try again shortly.', wait))
    })
  return {
    request,
    upgrade: async (
      socket: object,
      ip: Address,
      identify?: () => Promise<string | undefined>
    ): Promise<number> => {
      const wait = await arrival(ip, 'upgrade', socket)
      if (wait > 0 || bypass(socket) || identify == null) return wait
      let userId: string | undefined
      try {
        userId = await identify()
      } catch (error) {
        if (mode !== 'observe') throw error
        metrics?.missedUpgradeIdentity()
        return 0
      }
      return await request(ip, userId, 'aggregate', 'upgrade', socket)
    },
    scheduleBatch: gate(async req => {
      const rows: unknown = req.body?.games
      const userId = req.actor?.userId
      if (
        userId == null ||
        !Array.isArray(rows) ||
        rows.length === 0 ||
        rows.length > SCHEDULE_GAMES_MAX
      )
        return 0
      return await charge(
        [
          {
            key: 'account:' + userId + ':schedule-rows',
            budget: [1000, SCHEDULE_GAMES_MAX],
            scope: 'account',
            tier: 'rows',
            units: rows.length
          },
          {
            key: 'ip:' + ipKey(req.ip) + ':schedule-rows',
            budget: [200, 2 * SCHEDULE_GAMES_MAX],
            scope: 'signedInIp',
            tier: 'rows',
            units: rows.length
          }
        ],
        'rows',
        'http',
        req
      )
    }),
    beforeAuth: gate(async req => {
      if (
        mode === 'observe' &&
        loopbackKey != null &&
        verifyQueryToken(
          loopbackKey,
          ipKey(req.ip),
          req.headers[OBSERVE_PARENT_HEADER]
        )
      ) {
        shadowStopped.add(req)
        return 0
      }
      return await arrival(req.ip, 'http', req)
    }),
    afterAuth: gate(
      async req =>
        await request(
          req.ip,
          req.actor?.userId,
          apiCost(req.method, req.path),
          'http',
          req
        )
    )
  }
}
