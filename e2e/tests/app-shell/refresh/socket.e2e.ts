import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import type { FixtureManifest } from '../../../../src/server/dev/fixtures/accounts'
import { readJson } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import {
  clearSignInLimits,
  PHONE_WINDOW,
  stackDatabaseUrl
} from '../../../rigs/coach/coachApp'

/**
 * The web app reads again only when its WebSocket says something it shows
 * changed (#372): never on a timer, never on a return to the tab, once per
 * outage when the socket is down, and the bell's slow read leaves the rest
 * of the app alone. Requests are counted at the browser; changes are made
 * in the stack's database by a second writer, whose triggers publish the
 * same notices the API's own writes do.
 */

interface Read {
  at: number
  path: string
}

/** Every API read the page makes, from the moment it opens. */
interface Recorder {
  reads: Read[]
  sockets: number
  /** The socket's topic and scope frames, each way, as sent. */
  frames: string[]
  since: (at: number) => Read[]
  mark: () => number
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function record(session: WebSession): Promise<Recorder> {
  const reads: Read[] = []
  const recorder: Recorder = {
    reads,
    sockets: 0,
    frames: [],
    since: at => reads.filter(read => read.at >= at),
    mark: () => Date.now()
  }
  const cdp = await session.page.createCDPSession()
  await cdp.send('Network.enable')
  // Through CDP: the page's own request events miss the app's reads here.
  cdp.on(
    'Network.requestWillBeSent',
    (event: { request: { url: string; method: string } }) => {
      const url = new URL(event.request.url)
      if (!url.pathname.startsWith('/api/v1/')) return
      if (event.request.method !== 'GET') return
      reads.push({ at: Date.now(), path: url.pathname })
    }
  )
  cdp.on('Network.webSocketCreated', () => {
    recorder.sockets++
  })
  const frame =
    (way: string) =>
    (event: { response: { payloadData: string } }): void => {
      const data = event.response.payloadData
      if (/"(topic|topics|scope)"|userChanged|userResync/.test(data))
        recorder.frames.push(`${way} ${data}`)
    }
  cdp.on('Network.webSocketFrameSent', frame('sent'))
  cdp.on('Network.webSocketFrameReceived', frame('received'))
  cdp.on('Network.webSocketClosed', () => {
    recorder.frames.push('closed')
  })
  return recorder
}

/** Holds the bell's summary read for `ms` before it leaves the browser. */
async function slowBell(session: WebSession, ms: number): Promise<void> {
  const cdp = await session.page.createCDPSession()
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/v1/me/notifications/summary*' }]
  })
  cdp.on('Fetch.requestPaused', event => {
    setTimeout(() => {
      cdp
        .send('Fetch.continueRequest', { requestId: event.requestId })
        .catch(() => undefined)
    }, ms)
  })
}

/** Hides or shows the tab, as switching browser tabs does. */
async function setHidden(session: WebSession, hidden: boolean): Promise<void> {
  await session.page.evaluate((value: boolean) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (value ? 'hidden' : 'visible')
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => value
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

async function sql(
  ctx: E2eContext,
  text: string,
  values: unknown[] = []
): Promise<void> {
  const { Client } = await import('pg')
  const client = new Client({
    connectionString: await stackDatabaseUrl(ctx),
    connectionTimeoutMillis: 15_000
  })
  await client.connect()
  try {
    await client.query(text, values)
  } finally {
    await client.end()
  }
}

/**
 * Moves a game a minute later and announces it, in one transaction, as the
 * server's own reschedule does: to its game's sockets (`notifyGameChange`)
 * and to the screens that show it (`noteScopeChange`).
 */
async function reschedule(ctx: E2eContext, gameId: string): Promise<void> {
  await sql(
    ctx,
    `with moved as (
       update games set start_at = start_at + interval '1 minute'
       where id = $1 returning id
     )
     select
       pg_notify('game_changes', json_build_object('game', id, 'kind', 'game')::text),
       pg_notify('screen_scopes', json_build_object('gameId', id)::text)
     from moved`,
    [gameId]
  )
}

const SUMMARY = '/api/v1/me/notifications/summary'

/** Whether the bell's dot is on show. */
async function dotShown(session: WebSession): Promise<boolean> {
  return (
    (await session.page.$('[data-testid="notification-pending-dot"]')) != null
  )
}

/** The inbox's Pending list and the summary, read by the person's own API session. */
async function inboxOf(
  ctx: E2eContext,
  token: string
): Promise<{ listed: number; inbox: boolean; hasPending: boolean }> {
  const headers = { authorization: `Bearer ${token}` }
  const inbox = (await readJson(ctx.stack.origin, '/api/v1/me/notifications', {
    headers
  })) as { items: unknown[]; hasPending: boolean }
  const summary = (await readJson(ctx.stack.origin, SUMMARY, { headers })) as {
    hasPending: boolean
  }
  return {
    listed: inbox.items.length,
    inbox: inbox.hasPending,
    hasPending: summary.hasPending
  }
}

/** The world, a signed-in browser on it, and its reads. */
async function openAs(
  ctx: E2eContext,
  role: string
): Promise<{
  session: WebSession
  reads: Recorder
  ids: Record<string, string>
  world: FixtureManifest
}> {
  const world = await ctx.fixture('refresh-notices')
  await clearSignInLimits(ctx)
  const session = await ctx.browser(PHONE_WINDOW)
  const reads = await record(session)
  await session.m.openLink({ link: `${ctx.stack.origin}/` })
  await ctx.signIn(role, session.m)
  await sleep(3000)
  return { session, reads, ids: world.ids, world }
}

async function go(
  ctx: E2eContext,
  session: WebSession,
  path: string
): Promise<void> {
  await session.page.evaluate((to: string) => {
    window.history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await sleep(2500)
}

/** Counts by path, for a log line and a per-resource check. */
function byPath(reads: Read[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const read of reads) counts[read.path] = (counts[read.path] ?? 0) + 1
  return counts
}

function log(ctx: E2eContext, name: string, lines: string[]): void {
  writeFileSync(ctx.artifact(name), lines.join('\n') + '\n')
}

/** How long the spectator idles; `TS_IDLE_MINUTES` for a longer proof. */
const IDLE_MS = Number(process.env.TS_IDLE_MINUTES ?? 6) * 60_000
const OUTAGE_MS = 5 * 60_000

export default defineE2e({
  id: 'app-shell/refresh/socket',
  title: 'Reads follow the socket’s notices, never a timer',
  kind: 'e2e',
  covers: [
    'src/app/App.tsx',
    'src/app/hooks/useNoticedRead.ts',
    'src/app/hooks/useUserTopic.tsx',
    'src/app/hooks/useScreenScope.tsx',
    'src/app/sync/whenBack.ts',
    'src/app/sync/cachingClient.ts',
    'src/common/gameSocket.ts',
    'src/server/socket/gameSocket.ts',
    'src/server/socket/userNotices.ts',
    'src/server/notifications/pending.ts'
  ],
  stack: 'isolated',
  fixtures: ['refresh-notices'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: ['socket-drop'],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'spectator-idle': async ctx => {
      const { session, reads, ids, world } = await openAs(ctx, 'spectator')
      // Every step is measured before anything is asserted, so a run on the
      // base commit records each one.
      const lines: string[] = []
      const checks: Array<() => void> = []
      try {
        for (const path of ['/', '/schedule', '/account', `/games/${ids.far}`])
          await go(ctx, session, path)
        await go(ctx, session, '/schedule')
        await go(ctx, session, '/')
        const settled = reads.mark()
        lines.push(
          `$ opened Home, Schedule, Account, a game: ${reads.reads.length} reads`
        )
        lines.push(JSON.stringify(byPath(reads.reads)))
        const offlineScoring = reads.reads.filter(
          read => read.path === '/api/v1/me/offline-scoring'
        )
        checks.push(() => {
          expect(
            offlineScoring,
            'the web prepares no offline scoring'
          ).to.have.length(0)
        })

        // Hiding and showing the tab reads nothing of #372's. The age check
        // on a return is chat's own consent read (AgeGate), outside it.
        await setHidden(session, true)
        await sleep(2000)
        await setHidden(session, false)
        await sleep(3000)
        const shown = reads
          .since(settled)
          .filter(read => read.path !== '/api/v1/me/account/age')
        lines.push(
          `$ hid and showed the tab: ${JSON.stringify(byPath(reads.since(settled)))}`
        )
        checks.push(() => {
          expect(shown, 'a return to the tab reads nothing').to.deep.equal([])
        })

        // One game on the Schedule changes: only the Schedule reads again.
        await go(ctx, session, '/schedule')
        const moved = reads.mark()
        await reschedule(ctx, ids.soon.split(',')[0])
        await sleep(15_000)
        const afterMove = reads.since(moved)
        lines.push(
          `$ a game on the Schedule rescheduled: ${JSON.stringify(byPath(afterMove))}`
        )
        checks.push(() => {
          expect(afterMove.length, 'the Schedule reads again').to.be.at.least(1)
          expect(
            afterMove.filter(read => read.path !== '/api/v1/events'),
            'and nothing else: no sweep of games'
          ).to.deep.equal([])
        })

        // A slow bell is the bell's alone.
        await slowBell(session, 11_000)
        const rung = reads.mark()
        await sql(
          ctx,
          `insert into notification_events
             (id, source_type, source_id, revision, actor_id, metadata, recorded_recipients, created_at)
           values ($1, 'playerAddRejected', $1, 1, null, '{}', array[$2], now())`,
          [`e2e-${world.nonce}-slow`, world.accounts.spectator.userId]
        )
        await sleep(15_000)
        const offline =
          (await session.page.$('[data-testid="offlineBannerText"]')) != null
        const afterBell = reads.since(rung)
        lines.push(
          `$ the bell rung with its summary held 11 s: offline banner ${offline}, ${JSON.stringify(byPath(afterBell))}`
        )
        checks.push(() => {
          expect(offline, 'a slow summary leaves the app online').to.equal(
            false
          )
          expect(
            afterBell.map(read => read.path),
            'the bell reads its summary, once, and nothing else'
          ).to.deep.equal([SUMMARY])
        })

        // Idle: nothing at all.
        const idle = reads.mark()
        await sleep(IDLE_MS)
        const idleReads = reads.since(idle)
        lines.push(
          `$ idle ${IDLE_MS / 60_000} min: ${idleReads.length} reads ${JSON.stringify(byPath(idleReads))}`
        )
        lines.push(`sockets opened: ${reads.sockets}`)
        checks.push(() => {
          expect(idleReads, 'no read on a timer').to.deep.equal([])
          expect(reads.sockets, 'one socket for the session').to.equal(1)
        })
      } finally {
        log(ctx, 'idle-and-outage-after.spectator-idle.log', lines)
        await session.close()
      }
      for (const check of checks) check()
    },

    'badge-parity': async ctx => {
      const { session, reads, ids, world } = await openAs(ctx, 'spectator')
      const lines: string[] = []
      try {
        await go(ctx, session, '/account')
        const { signInTestAccount } =
          await import('../../../../src/test/passwordFixtures')
        const spectator = world.accounts.spectator
        const token = await signInTestAccount(
          `${ctx.stack.origin}/api/v1`,
          spectator
        )
        lines.push(`$ opened Account: ${JSON.stringify(byPath(reads.reads))}`)
        const event = `e2e-${world.nonce}-removed`
        const teams = ids.teams.split(',')
        /** One step: the writer's change, then the dot, the reads and the inbox. */
        const step = async (
          name: string,
          change: () => Promise<void>,
          dot: boolean
        ): Promise<void> => {
          const at = reads.mark()
          await change()
          await sleep(5000)
          const summaries = reads
            .since(at)
            .filter(read => read.path === SUMMARY).length
          const shown = await dotShown(session)
          const inbox = await inboxOf(ctx, token)
          lines.push(
            `$ ${name}: dot ${shown}, summary reads ${summaries}, inbox lists ${inbox.listed} with hasPending ${inbox.inbox}, summary hasPending ${inbox.hasPending}`
          )
          expect(summaries, `${name}: one summary read`).to.equal(1)
          expect(shown, `${name}: the dot`).to.equal(dot)
          expect(
            inbox.hasPending,
            `${name}: the badge is the inbox's`
          ).to.equal(inbox.inbox)
          expect(shown, `${name}: the dot is the inbox's`).to.equal(
            inbox.hasPending
          )
        }
        await step(
          'created',
          async () => {
            await sql(
              ctx,
              `insert into notification_events
                 (id, source_type, source_id, revision, actor_id, metadata, recorded_recipients, created_at)
               values ($1, 'playerAddRejected', $1, 1, null, $2, array[$3], now())`,
              [
                event,
                JSON.stringify({
                  teamId: teams[0],
                  userId: world.accounts.scorer.userId,
                  teamName: 'Hawks',
                  mode: 'roster',
                  games: 0,
                  remover: 'self'
                }),
                spectator.userId
              ]
            )
          },
          true
        )
        await step(
          'viewed',
          async () => {
            await sql(
              ctx,
              `insert into notification_receipts (event_id, user_id, viewed_at)
               values ($1, $2, now())`,
              [event, spectator.userId]
            )
          },
          true
        )
        await step(
          'a membership removed, nothing waiting on it',
          async () => {
            await sql(
              ctx,
              'delete from memberships where team_id = $1 and user_id = $2',
              [teams[3], spectator.userId]
            )
          },
          true
        )
        await step(
          'dismissed',
          async () => {
            await sql(
              ctx,
              `update notification_receipts set dismissed_at = now()
               where event_id = $1 and user_id = $2`,
              [event, spectator.userId]
            )
          },
          false
        )
      } finally {
        log(ctx, 'idle-and-outage-after.badge-parity.log', [
          ...lines,
          'socket frames:',
          ...reads.frames
        ])
        await session.close()
      }
    },

    'failed-connection': async ctx => {
      const setFault = ctx.stack.setFault
      if (setFault == null)
        throw new BlockedError('needs the stack’s fault server')
      const { session, reads, ids } = await openAs(ctx, 'spectator')
      const lines: string[] = []
      try {
        await go(ctx, session, '/schedule')
        const before = reads.mark()
        await setFault('socket-drop')
        await sleep(20_000)
        await reschedule(ctx, ids.soon.split(',')[0])
        await sleep(OUTAGE_MS)
        const outage = byPath(reads.since(before))
        lines.push(
          `$ socket refused ${OUTAGE_MS / 60_000} min: ${JSON.stringify(outage)}`
        )
        for (const [path, count] of Object.entries(outage))
          expect(
            count,
            `one fallback read of ${path} for the outage`
          ).to.be.at.most(1)

        const restored = reads.mark()
        await setFault(null)
        await sleep(60_000)
        const catchUp = byPath(reads.since(restored))
        lines.push(`$ socket back: ${JSON.stringify(catchUp)}`)
        for (const [path, count] of Object.entries(catchUp))
          expect(count, `one catch-up read of ${path}`).to.be.at.most(1)

        // A scope the person lost reads nothing more.
        const teams = ids.teams.split(',')
        await go(ctx, session, `/teams/${teams[3]}`)
        const revoked = reads.mark()
        await sql(
          ctx,
          'delete from memberships where team_id = $1 and role = $2',
          [teams[3], 'member']
        )
        await sleep(20_000)
        const denied = reads.since(revoked)
        lines.push(`$ membership revoked: ${JSON.stringify(byPath(denied))}`)
        expect(
          denied.length,
          'a denied scope never falls back to reading'
        ).to.be.at.most(1)

        // Another account sees nothing of the first.
        await go(ctx, session, '/account')
        await session.m.tapOn({ text: 'Sign out' })
        await sleep(3000)
        await ctx.signIn('scorer', session.m)
        await go(ctx, session, '/account')
        const text = await session.page.evaluate(() => document.body.innerText)
        expect(text, 'no old-account data').not.to.contain('Sam Spectator')
        lines.push('$ signed in as the scorer: no spectator data on Account')
      } finally {
        log(ctx, 'idle-and-outage-after.failed-connection.log', lines)
        await setFault(null).catch(() => undefined)
        await session.close()
      }
    }
  }
})
