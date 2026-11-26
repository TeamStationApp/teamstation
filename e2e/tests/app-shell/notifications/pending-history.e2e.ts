import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import type { Notification } from '../../../../src/common/notifications'
import { eventually, readJson } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import { clearSignInLimits, PHONE_WINDOW } from '../../../rigs/coach/coachApp'

const PENDING = '/api/v1/me/notifications'

export default defineE2e({
  id: 'app-shell/notifications/pending-history',
  title: 'Resolved history leaves Pending and the bell responsive',
  kind: 'e2e',
  covers: [
    'src/server/notifications/inbox.ts',
    'src/server/notifications/pendingRequests.ts',
    'src/app/screens/NotificationsScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['pending-history'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: ['api-500'],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'resolved-history': async ctx => {
      const world = await ctx.fixture('pending-history')
      const { signInTestAccount } =
        await import('../../../../src/test/passwordFixtures')
      const lines: string[] = []
      try {
        for (const role of ['small', 'empty', 'paged']) {
          await clearSignInLimits(ctx)
          const session = await ctx.browser(PHONE_WINDOW)
          const requests = new Map<
            string,
            { path: string; at: number; status?: number }
          >()
          const timings: Array<{ path: string; ms: number; status: number }> =
            []
          const failures: string[] = []
          const cdp = await session.page.createCDPSession()
          await cdp.send('Network.enable')
          cdp.on('Network.requestWillBeSent', event => {
            const url = new URL(event.request.url)
            if (
              event.request.method === 'GET' &&
              (url.pathname === PENDING ||
                url.pathname === `${PENDING}/summary`)
            )
              requests.set(event.requestId, {
                path: url.pathname + url.search,
                at: event.timestamp
              })
          })
          cdp.on('Network.responseReceived', event => {
            const request = requests.get(event.requestId)
            if (request != null) request.status = event.response.status
          })
          cdp.on('Network.loadingFinished', event => {
            const request = requests.get(event.requestId)
            if (request != null)
              timings.push({
                path: request.path,
                ms: Math.round((event.timestamp - request.at) * 1000),
                status: request.status ?? 0
              })
          })
          cdp.on('Network.loadingFailed', event => {
            if (requests.has(event.requestId)) failures.push(event.errorText)
          })
          try {
            await session.m.openLink({ link: `${ctx.stack.origin}/` })
            await ctx.signIn(role, session.m)
            const token = await signInTestAccount(
              `${ctx.stack.origin}/api/v1`,
              world.accounts[role]
            )
            const headers = { authorization: `Bearer ${token}` }
            const read = async (): Promise<{
              items: Notification[]
              hasPending: boolean
              nextCursor: string | null
            }> =>
              (await readJson(ctx.stack.origin, PENDING, { headers })) as {
                items: Notification[]
                hasPending: boolean
                nextCursor: string | null
              }
            const open = async (): Promise<void> => {
              await session.m.tapOn({ text: 'Account, .*' })
              await session.m.tapOn({
                text: '^Notifications$',
                childOf: { id: 'header-menu-panel' }
              })
            }
            await open()
            const first = await read()
            expect(first.items).has.length(
              role === 'small' ? 3 : role === 'empty' ? 0 : 25
            )
            expect(first.hasPending).equals(role !== 'empty')
            await ctx.checkpoint(`${role}-pending`, {
              expect:
                role === 'empty'
                  ? [
                      { text: 'No approvals are waiting for you.' },
                      { id: 'notification-pending-dot', absent: true }
                    ]
                  : [{ id: `notification-row-${first.items[0].requestId}` }],
              readBack: async () => {
                const summary = (await readJson(
                  ctx.stack.origin,
                  `${PENDING}/summary`,
                  { headers }
                )) as { hasPending: boolean }
                expect(summary.hasPending).equals(first.hasPending)
              }
            })
            if (role === 'small') {
              expect(first.items.map(row => row.id).sort()).deep.equals(
                [
                  world.ids.recordingUpload,
                  world.ids.playerAddRejected,
                  world.ids.umpireMissingSlots
                ].sort()
              )
              const dismissible = first.items.find(
                row => row.type === 'playerAddRejected'
              )!
              await session.m.scrollUntilVisible({
                element: { id: `notification-row-${dismissible.requestId}` }
              })
              await session.m.tapOn({ text: `Dismiss ${dismissible.title}` })
              await eventually(async () => {
                expect((await read()).items).has.length(2)
              })
              await ctx.checkpoint('dismissed', {
                expect: [
                  {
                    id: `notification-row-${dismissible.requestId}`,
                    absent: true
                  },
                  { id: 'notification-pending-dot' }
                ]
              })
              await session.m.openLink({ link: `${ctx.stack.origin}/account` })
              await open()
              await ctx.checkpoint('returned-to-pending', {
                readBack: async () => {
                  expect((await read()).items).has.length(2)
                }
              })
            }
            if (role === 'paged') {
              expect(first.nextCursor).not.equals(null)
              const last = world.ids.pagedActive.split(',').sort().at(-1)!
              // The browser driver's scrollUntilVisible stops at ten scrolls;
              // a page of full invitation cards takes more than that.
              for (let step = 0; step < 40; step++) {
                const visible = await session.page.evaluate((id: string) => {
                  const row = document.querySelector(
                    `[data-testid="notification-row-${id}"]`
                  )
                  if (row == null) return false
                  const rect = row.getBoundingClientRect()
                  return (
                    rect.top >= 50 && rect.bottom <= window.innerHeight - 90
                  )
                }, last)
                if (visible) break
                await session.m.scroll({ direction: 'DOWN' })
              }
              expect(
                timings.some(row => row.path.includes('cursor=')),
                'the browser fetched its second page'
              ).equals(true)
              const next = (await readJson(
                ctx.stack.origin,
                `${PENDING}?cursor=${encodeURIComponent(first.nextCursor!)}`,
                { headers }
              )) as { items: Notification[] }
              expect(
                [...first.items, ...next.items].map(row => row.requestId).sort()
              ).deep.equals(world.ids.pagedActive.split(',').sort())
              lines.push(
                JSON.stringify({
                  role,
                  firstPage: first.items.length,
                  secondPage: next.items.length
                })
              )
              await ctx.checkpoint('second-page', {
                expect: [{ id: `notification-row-${last}` }]
              })
            }
            await eventually(async () => {
              expect(timings.some(row => row.path === PENDING)).equals(true)
              expect(
                timings.some(row => row.path === `${PENDING}/summary`)
              ).equals(true)
            })
            expect(
              failures,
              'no failed first request hidden by retries'
            ).deep.equals([])
            for (const timing of timings) {
              expect(timing.status, timing.path).equals(200)
              expect(timing.ms, timing.path).lessThan(2000)
            }
          } catch (error) {
            await session.m
              .takeScreenshot({ path: ctx.artifact(`${role}-failed.png`) })
              .catch(() => undefined)
            throw error
          } finally {
            lines.push(
              JSON.stringify({ role, resolved: 1000, timings, failures })
            )
            await session.close()
          }
        }
      } finally {
        writeFileSync(
          ctx.artifact('pending-history-requests.log'),
          lines.join('\n') + '\n'
        )
      }
    }
  }
})
