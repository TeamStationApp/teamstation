import { writeFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'

import { expect } from 'chai'

import { signInTestAccount } from '../../../../src/test/passwordFixtures'
import { faultControl, requireDropletHandle } from '../../../core/dropletStack'
import type { FixtureManifest } from '../../../core/fixtures'
import { eventually, readJson } from '../../../core/readback'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { FIELD_SCENE_PROBE, measuredBoard } from '../../../rigs/fieldPointer'
import {
  expectSwapped,
  remotePitch,
  RESET_AND_SWAP_REPORT,
  scoringSwapFixture
} from '../../../rigs/scoringLayout'

const strip = '[data-testid="scoringNotice"]'
const held = '[data-testid="heldGameMessage"]'
const offline = "Offline. Edits will send when you're back online."
const parked =
  "The server's copy of this game changed. The innings scored here are still in this tab and were not sent."
const conflict =
  'Someone else edited this roster. Saving may overwrite their changes. Cancel takes theirs.'
const tap = async (s: WebSession, label: string): Promise<void> =>
  await s.m.tapOn({ css: `[aria-label="${label}"]`, timeout: 30000 })

async function open(
  ctx: E2eContext,
  world: FixtureManifest,
  role = 'scorekeeper'
): Promise<WebSession> {
  const s = await ctx.browser(
    { width: 390, height: 844 },
    { beforeLoad: FIELD_SCENE_PROBE, observeNetwork: true }
  )
  try {
    await s.m.openLink({ link: ctx.stack.origin })
    await ctx.signIn(role, s.m)
    const route = role === 'coach' ? 'coach/' + world.ids.homeTeam : 'score'
    await s.m.openLink({
      link: `${ctx.stack.origin}/games/${world.ids.game}/${route}`
    })
    if (role !== 'coach')
      await s.m.assertVisible({ text: '^Ball$', timeout: 60000 })
    return s
  } catch (error) {
    await s.close()
    throw error
  }
}

async function peerBall(
  ctx: E2eContext,
  world: FixtureManifest,
  s: WebSession
): Promise<void> {
  const peer = await remotePitch(ctx, world)
  try {
    await peer.pitch()
    await s.page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="remote-scoring-update-lines"]')
          ?.textContent?.includes('Score P'),
      { timeout: 30000 }
    )
  } finally {
    await peer.close()
  }
}
async function geometry(s: WebSession, includeLog = false): Promise<unknown> {
  const boxes = await s.page.evaluate(log => {
    const rect = (sel: string): number[] => {
      const b = document.querySelector(sel)!.getBoundingClientRect()
      return [b.x, b.y, b.width, b.height]
    }
    return [
      'canvas[data-field-ready="true"]',
      '[aria-label="Open scoring menu"]',
      '[aria-label="Ball"]',
      '[data-testid="scoring-log-band"]',
      ...(log ? ['[data-testid="remote-scoring-updates"]'] : [])
    ].map(rect)
  }, includeLog)
  return { boxes, board: await measuredBoard(s.page) }
}

async function notice(s: WebSession, message: string): Promise<void> {
  await s.page.waitForFunction(
    (sel, t) => document.querySelector(sel)?.textContent === t,
    { timeout: 30000 },
    strip,
    message
  )
  await s.page.waitForFunction(
    sel => {
      const n = document.querySelector(sel)
      return (
        n != null &&
        Math.abs(
          n.getBoundingClientRect().bottom -
            document
              .querySelector('[data-testid="scoring-notice-strip"]')!
              .getBoundingClientRect().bottom
        ) < 1
      )
    },
    {},
    strip
  )
}
const snapshot = async (
  ctx: E2eContext,
  s: WebSession,
  name: string
): Promise<void> => {
  writeFileSync(ctx.artifact(name + '.png'), await s.m.screenshot())
}

async function menuSwap(s: WebSession): Promise<void> {
  await tap(s, 'Open scoring menu')
  await s.m.tapOn({ text: 'Swap Home and Away' })
  await s.m.tapOn({ text: 'Reset and Swap' })
}
async function calls(
  ctx: E2eContext,
  world: FixtureManifest
): Promise<() => Promise<number>> {
  const token = await signInTestAccount(
    ctx.stack.origin + '/api/v1',
    world.accounts.coach
  )
  return async () => {
    const events = await readJson(
      ctx.stack.origin,
      `/api/v1/games/${world.ids.game}/events`,
      { headers: { authorization: 'Bearer ' + token } }
    )
    return [...JSON.stringify(events).matchAll(/"call":\{"code":"B"/g)].length
  }
}

/** Read the scoring client's actual queue for this game, through the mounted test root. */
async function queueState(
  s: WebSession,
  game: string
): Promise<{ count: number; state?: string }> {
  return await s.page.evaluate(async gameId => {
    interface Fiber {
      child?: Fiber
      sibling?: Fiber
      memoizedProps?: {
        gameId?: string
        client?: {
          outboxSummary?: () => Promise<{
            chains: Record<string, number>
            games: Record<string, { state: string }>
          }>
        }
      }
    }
    const nodes = (
      window as unknown as { qaRoots: Array<{ current: Fiber }> }
    ).qaRoots.map(root => root.current)
    while (nodes.length > 0) {
      const node = nodes.pop()!
      if (node.child != null) nodes.push(node.child)
      if (node.sibling != null) nodes.push(node.sibling)
      const props = node.memoizedProps
      if (props?.gameId === gameId && props.client?.outboxSummary != null) {
        const summary = await props.client.outboxSummary()
        return {
          count: summary.chains['game:' + gameId] ?? 0,
          state: summary.games[gameId]?.state
        }
      }
    }
    throw new Error('The scoring queue has not mounted')
  }, game)
}

async function queueScenario(
  ctx: E2eContext,
  mode: 'hold' | 'stale'
): Promise<void> {
  const world = await scoringSwapFixture(ctx)
  const faults =
    ctx.stack.attached == null
      ? undefined
      : requireDropletHandle(ctx.stack.attached).faults
  if (faults == null)
    throw new Error('This scenario needs the isolated droplet event gate')
  const control = faultControl(faults)
  const route = 'event-gate/' + world.ids.game
  const count = await calls(ctx, world)
  const s = await open(ctx, world)
  try {
    await peerBall(ctx, world, s)
    const before = await geometry(s, true)
    // Also block this page's event POST at request interception. CDP can keep
    // an existing connection alive across the emulated device transition.
    let disconnected = true
    await s.page.setRequestInterception(true)
    s.page.on('request', request => {
      if (request.isInterceptResolutionHandled()) return
      const toGame =
        new URL(request.url()).pathname ===
        '/api/v1/games/' + world.ids.game + '/events'
      const result =
        disconnected && request.method() === 'POST' && toGame
          ? request.abort('internetdisconnected')
          : request.continue()
      result.catch(() => undefined)
    })
    await s.page.setOfflineMode(true)
    await tap(s, 'Ball')
    if (mode === 'hold') await tap(s, 'Ball')
    await notice(s, offline)
    expect(await geometry(s, true)).deep.equals(before)
    expect(await count()).equals(1)
    await eventually(async () => {
      expect((await queueState(s, world.ids.game)).count).greaterThan(0)
    })

    await control.call('PUT', route, { mode })
    try {
      disconnected = false
      await s.page.setOfflineMode(false)
      // CDP's offline emulation affects requests; dispatch the connectivity notification
      // delivered by a phone's browser when its network is back.
      await s.page.evaluate(() => window.dispatchEvent(new Event('online')))
      await eventually(async () => {
        expect(
          ((await control.call('GET', route)) as { arrivals: number }).arrivals
        ).greaterThan(0)
      }, 30000)
      if (mode === 'hold') {
        await notice(s, 'Saving…')
        expect(await geometry(s, true)).deep.equals(before)
        await snapshot(ctx, s, 'reconnect-saving-after')
      } else {
        await s.page.waitForSelector(held, { visible: true, timeout: 30000 })
        expect(
          await s.page.$eval(held, n =>
            n.querySelector('[aria-label]')?.getAttribute('aria-label')
          )
        ).equals(parked)
        expect((await queueState(s, world.ids.game)).state).equals('parked')
        await pause(8400)
        expect(await s.page.$(held)).not.equals(null)
        await snapshot(ctx, s, 'held-game-after')
        await tap(s, 'Unsent changes')
        await s.m.assertVisible({ text: 'Try Again' })
        await s.m.assertVisible({ text: "Use Server's Copy" })
        await snapshot(ctx, s, 'held-choice-after')
        await tap(s, 'Cancel')
        await tap(s, 'Unsent changes')
        await tap(s, "Use Server's Copy")
      }
    } finally {
      await control.call('DELETE', route)
    }
    await s.page.waitForSelector(mode === 'hold' ? strip : held, {
      hidden: true,
      timeout: 30000
    })
    await eventually(async () => {
      expect((await queueState(s, world.ids.game)).count).equals(0)
      expect(await count()).equals(mode === 'hold' ? 3 : 1)
    }, 30000)
  } finally {
    await s.close()
  }
}

export default defineE2e({
  id: 'scoring/notices/bottom-bar',
  title: 'Scoring notices stay in the bottom strip',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringNoticeBar.tsx',
    'src/app/scoring/scoringNotice.ts',
    'src/app/scoring/ScoringScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'swap-report': async ctx => {
      const world = await scoringSwapFixture(ctx)
      const s = await open(ctx, world)
      try {
        await peerBall(ctx, world, s)
        const before = await geometry(s)
        await menuSwap(s)
        await notice(s, RESET_AND_SWAP_REPORT)
        const shown = Date.now()
        expect(await geometry(s)).deep.equals(before)
        const box = await s.page.$eval(strip, n => {
          const r = n.getBoundingClientRect()
          const css = getComputedStyle(n)
          return [
            r.left,
            r.right,
            r.bottom,
            css.backgroundColor,
            css.borderTopLeftRadius,
            css.pointerEvents
          ]
        })
        expect(box).deep.equals([
          0,
          390,
          844,
          'rgb(255, 211, 77)',
          '0px',
          'none'
        ])
        expect(
          await s.page.$$('[aria-label="' + RESET_AND_SWAP_REPORT + '"]')
        ).length(1)
        await snapshot(ctx, s, 'swap-notice-after')
        await expectSwapped(ctx, world)
        await s.page.waitForSelector(strip, { hidden: true, timeout: 10500 })
        expect(Date.now() - shown).within(7000, 10000)
        await pause(250)
        expect(await geometry(s)).deep.equals(before)
      } finally {
        await s.close()
      }
    },
    'held-game': async ctx => {
      await queueScenario(ctx, 'stale')
    },
    'offline-and-back': async ctx => {
      await queueScenario(ctx, 'hold')
    },
    'roster-conflict': async ctx => {
      const world = await scoringSwapFixture(ctx)
      const s = await open(ctx, world)
      try {
        const coach = await open(ctx, world, 'coach')
        try {
          await coach.resize({ width: 1000, height: 850 })
          const edit = async (): Promise<void> => {
            await tap(s, 'Open scoring menu')
            await tap(s, 'Set Team Rosters')
            for (const tab of ['Home Team', 'Lineup'])
              await s.m.tapOn({ css: `[role="tab"][aria-label="${tab}"]` })
          }
          const move = async (
            session: WebSession,
            from: number,
            to: number
          ): Promise<void> => {
            await session.m.dragAndDrop({
              from: { css: `[data-roster-target="lineup-${from}"]` },
              to: { css: `[data-roster-target="lineup-${to}"]` },
              holdDuration: 800,
              duration: 800
            })
            await session.page.waitForFunction(
              () =>
                document
                  .querySelector('[aria-label="Save Rosters"]')
                  ?.getAttribute('aria-disabled') !== 'true'
            )
          }
          const order = async (session: WebSession): Promise<string[]> =>
            await session.page.$$eval(
              '[data-roster-target^="lineup-"][data-roster-player]',
              nodes => nodes.map(n => n.getAttribute('data-roster-player')!)
            )
          await edit()
          await tap(coach, 'Lineup')
          await move(s, 1, 4)
          await move(coach, 3, 5)
          const theirs = await order(coach)
          await tap(coach, 'Save Rosters')
          await notice(s, conflict)
          expect(await s.page.$('[aria-modal="true"] ' + strip)).not.equals(
            null
          )
          expect(await s.page.$('[data-testid="Roster conflict"]')).equals(null)
          await snapshot(ctx, s, 'roster-conflict-after')
          await tap(s, 'Cancel')
          await s.page.waitForSelector(strip, { hidden: true })
          await edit()
          expect(await order(s)).deep.equals(theirs)
          await move(coach, 0, 3)
          await move(s, 2, 5)
          await tap(s, 'Save Rosters')
          await coach.page.waitForSelector('[data-testid="Roster conflict"]', {
            visible: true
          })
          await snapshot(ctx, coach, 'coach-roster-conflict-after')
        } finally {
          await coach.close()
        }
      } finally {
        await s.close()
      }
    }
  }
})
