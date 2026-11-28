import { expect } from 'chai'

import type { CheckpointSpec } from '../../../core/checkpoint'
import { readJson } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { clearSignInLimits, PHONE_WINDOW } from '../../../rigs/coach/coachApp'
import {
  centre,
  clearOfBar,
  pageFields,
  signInOnPhone
} from '../../../rigs/mobileWeb'

/**
 * The web app's main flows, the same steps on Chrome on a desktop window,
 * on Safari on an iPhone and on Chrome on an Android phone (#358): the web
 * now runs the phone's queued client and its outbox, app-wide. Each flow
 * signs in through the real password form and reads back from the server
 * what it changed. Offline is the stack's fault server (`api-hang`), never
 * the phone's own network.
 */

interface World {
  game: string
  homeTeam: string
  awayTeam: string
  coach: { email: string; password: string }
}

/** The Create Player form's fields, top to bottom. */
/**
 * The pad's Ball button. Once a play is scored the last play's row above it
 * also reads "Ball", and a tap there is an undo.
 */
const BALL = { text: 'Ball', below: { text: 'MORE' } }

const FORM_ORDER = ['First name', 'Last name', 'Jersey number']

/** The world's accounts by role, for the password form on a phone. */
const accounts = new Map<string, { email: string; password: string }>()

/** A world's accounts, for signing in by role on a phone. */
function rememberAccounts(world: {
  accounts: Record<string, { email: string; password: string }>
}): void {
  for (const [role, account] of Object.entries(world.accounts))
    accounts.set(role, { email: account.email, password: account.password })
}

async function worldOf(ctx: E2eContext): Promise<World> {
  const world = await ctx.fixture('coach-game')
  rememberAccounts(world)
  const coach = world.accounts.coach
  return {
    game: world.ids.game,
    homeTeam: world.ids.homeTeam,
    awayTeam: world.ids.awayTeam,
    coach: { email: coach.email, password: coach.password }
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The web app, signed in as `role`, on this run's surface. */
interface WebApp {
  m: any
  go: (path: string) => Promise<void>
  /** Types into the field labelled `label`. */
  fill: (label: string, text: string) => Promise<void>
  /**
   * Types into the one text box labelled `label` on a page with no form
   * order, such as a chat's composer (on Android Chrome, the lowest field).
   */
  type: (label: string, text: string) => Promise<void>
}

/**
 * `ctx.checkpoint`, then the screen it checked kept in the run directory as
 * `<id>.png`: the flow's proof on each surface.
 */
async function checkpoint(
  ctx: E2eContext,
  id: string,
  spec: CheckpointSpec,
  m: any
): Promise<void> {
  await ctx.checkpoint(id, spec, m)
  // Once what it checks is on screen: a page still drawing is blank.
  await m
    .takeScreenshot({ path: ctx.artifact(`${id}.png`) })
    .catch(() => undefined)
}

async function openWebApp(ctx: E2eContext, role: string): Promise<WebApp> {
  const origin = ctx.stack.origin
  const phone = ctx.surface !== 'web-chromium'
  const ios = ctx.surface === 'web-safari-ios'
  // Every flow signs in twice (the page, the read-back): limits start clear.
  await clearSignInLimits(ctx)
  const account = accounts.get(role)
  if (account == null) throw new Error(`no ${role} in this world`)
  const m = phone
    ? await ctx.mobileBrowser('phone', `${origin}/`)
    : (await ctx.browser(PHONE_WINDOW)).m
  if (!phone) {
    await m.openLink({ link: `${origin}/` })
    await ctx.signIn(role, m)
  } else await signInOnPhone(m, account, origin, ios)
  return {
    m,
    fill: async (label, text) => {
      if (ios) {
        await m.hideKeyboard().catch(() => undefined)
        await m.tapOn({ id: label })
        await m.inputText({ text })
        return
      }
      if (phone) {
        // Android's Chrome names no web field: it is found by its place.
        const at = FORM_ORDER.indexOf(label)
        await m.hideKeyboard().catch(() => undefined)
        const fields = await pageFields(m)
        if (at < 0 || fields[at] == null)
          throw new Error(`no field ${label} among ${fields.length}`)
        await m.tapOn({ point: centre(fields[at].bounds) })
        await m.inputText({ text })
        return
      }
      // The field itself, not the label drawn above it.
      await m.tapOn({ css: `[aria-label="${label}"]` })
      await m.inputText({ text })
    },
    type: async (label, text) => {
      if (!phone)
        await m.tapOn({
          css: `textarea[aria-label="${label}"], input[aria-label="${label}"]`
        })
      else if (ios) await m.tapOn({ id: label, timeout: 30000 })
      else {
        let fields = await pageFields(m)
        for (let i = 0; i < 30 && fields.length === 0; i++) {
          await sleep(1000)
          fields = await pageFields(m)
        }
        const field = fields.at(-1)
        if (field == null) throw new Error(`no field for ${label}`)
        await m.tapOn({ point: centre(field.bounds) })
      }
      await m.inputText({ text })
    },
    go: async path => {
      await m.openLink({
        link: `${origin}${path}`,
        ...(phone ? { browser: true } : {})
      })
    }
  }
}

/** The coach's API session, signed in once: sign-ins are rate limited. */
const tokens = new Map<string, string>()

/** Reads `path` from the stack's API as the home team's coach. */
async function asCoach(
  ctx: E2eContext,
  world: World,
  path: string
): Promise<unknown> {
  let token = tokens.get(world.coach.email)
  if (token == null) {
    const { signInTestAccount } =
      await import('../../../../src/test/passwordFixtures')
    token = await signInTestAccount(`${ctx.stack.origin}/api/v1`, world.coach)
    tokens.set(world.coach.email, token)
  }
  return await readJson(ctx.stack.origin, `/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` }
  })
}

/** The pitch calls the server holds for the game, in order. */
async function callsOnServer(ctx: E2eContext, world: World): Promise<string[]> {
  const events = JSON.stringify(
    await asCoach(ctx, world, `/games/${world.game}/events`)
  )
  return [...events.matchAll(/"call":\{"code":"([A-Z*]+)"/g)].map(
    found => found[1]
  )
}

/** Waits up to `ms` for `check` to hold. */
async function until(
  ms: number,
  check: () => Promise<boolean>
): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(1000)
  }
  return await check()
}

/** The scoring screen of the game, settled so a tap lands. */
async function openScoring(app: WebApp, world: World): Promise<void> {
  await app.go(`/games/${world.game}/score`)
  await app.m.extendedWaitUntil({
    visible: { text: 'Ball' },
    timeout: 60000
  })
  await sleep(1500)
}

export default defineE2e({
  id: 'platform/web/main-flows',
  title:
    'The web app’s main flows work on the queued client, in Chrome, Safari on an iPhone and Chrome on an Android phone',
  kind: 'e2e',
  covers: [
    'src/app/App.tsx',
    'src/app/sync/cache.ts',
    'src/app/sync/wasmSqliteExecutor.ts',
    'src/app/sync/cachingClient.ts',
    'src/app/sync/outbox.ts',
    'src/app/scoring/ScoringScreen.tsx',
    'src/build.mjs'
  ],
  stack: 'isolated',
  fixtures: ['coach-game', 'streaming', 'packed-league'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
    'web-safari-ios': {
      devices: [{ role: 'phone', needs: ['ios'], hardware: 'required' }]
    },
    'web-chrome-android': {
      devices: [{ role: 'phone', needs: ['android'], hardware: 'required' }]
    }
  },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  // `offline-scoring` sets and clears `api-hang` itself, as setup.
  faults: [],
  manual: false,
  scenarios: {
    'sign-in': async ctx => {
      await worldOf(ctx)
      const app = await openWebApp(ctx, 'coach')
      await checkpoint(
        ctx,
        'signed-in',
        { expect: [{ text: 'Your Home', timeout: 30000 }] },
        app.m
      )
      // Out, and the sign-in screen is back.
      await app.go('/account')
      await app.m.scrollUntilVisible({
        element: { text: 'Sign out' },
        direction: 'DOWN'
      })
      // A mouse drag selects account text in Chromium. Scroll the button
      // above the floating navigation bar before tapping it.
      if (ctx.surface === 'web-chromium') {
        await app.m.scroll({ direction: 'DOWN' })
      } else {
        await clearOfBar(app.m)
      }
      await app.m.tapOn({ text: 'Sign out' })
      await checkpoint(
        ctx,
        'signed-out',
        { expect: [{ text: 'Sign in to TeamStation', timeout: 30000 }] },
        app.m
      )
    },
    schedule: async ctx => {
      const world = await worldOf(ctx)
      const app = await openWebApp(ctx, 'coach')
      // By its address: on a phone the app's own bar has a Schedule too.
      await app.go(`/teams/${world.homeTeam}?tab=schedule`)
      await app.m.scrollUntilVisible({
        element: { text: '.*Visitors.*' },
        direction: 'DOWN',
        timeout: 30000
      })
      // The game the team plays, by its opponent.
      await checkpoint(
        ctx,
        'team-schedule',
        { expect: [{ text: '.*Visitors.*', timeout: 30000 }] },
        app.m
      )
    },
    'team-roster': async ctx => {
      const world = await worldOf(ctx)
      const app = await openWebApp(ctx, 'coach')
      await app.go(`/groups/team/${world.homeTeam}/settings`)
      await app.m.scrollUntilVisible({
        element: { text: 'Create Player' },
        direction: 'DOWN'
      })
      await app.m.tapOn({ text: 'Create Player' })
      await app.fill('First name', 'Main')
      await app.fill('Last name', 'Flow')
      await app.fill('Jersey number', '77')
      await app.m.hideKeyboard().catch(() => undefined)
      // A position by its chip in a desktop window. On a phone the tap can
      // land on the browser's own bar; the player is made without one.
      if (ctx.surface === 'web-chromium') await app.m.tapOn({ text: 'P' })
      await app.m.scrollUntilVisible({
        element: { text: 'Create Player and Add Another' },
        direction: 'DOWN'
      })
      await clearOfBar(app.m)
      await app.m.tapOn({ text: 'Create Player and Add Another' })
      await app.m.assertVisible({
        text: '.*Created Main Flow.*',
        timeout: 30000
      })
      await checkpoint(
        ctx,
        'player-saved',
        {
          readBack: async () => {
            expect(
              await until(30000, async () =>
                JSON.stringify(
                  await asCoach(ctx, world, `/teams/${world.homeTeam}/roster`)
                ).includes('Main')
              ),
              'the new player on the server’s roster'
            ).equals(true)
          }
        },
        app.m
      )
    },
    'game-page': async ctx => {
      const world = await worldOf(ctx)
      const app = await openWebApp(ctx, 'coach')
      await app.go(`/games/${world.game}`)
      await checkpoint(
        ctx,
        'game-page',
        {
          // By its words: a web page's test ids are not in a phone
          // browser's accessibility tree.
          expect: [
            { text: 'Visitors', timeout: 60000 },
            { text: 'Hosts' },
            { text: 'Box score' }
          ]
        },
        app.m
      )
    },
    'scoring-swap': async ctx => {
      const world = await worldOf(ctx)
      const app = await openWebApp(ctx, 'scorekeeper')
      await openScoring(app, world)
      await app.m.tapOn(BALL)
      // The swap is offered once something is kept on the server.
      expect(
        await until(30000, async () =>
          (await callsOnServer(ctx, world)).includes('B')
        ),
        'the Ball on the server'
      ).equals(true)
      await sleep(1000)
      await app.m.tapOn({ text: 'Open scoring menu' })
      await app.m.tapOn({ text: 'Swap Home and Away' })
      await app.m.tapOn({ text: 'Reset and Swap|Confirm Swap' })
      if (ctx.surface === 'web-chromium')
        await app.m.assertVisible({
          css: '[data-testid="scoringNotice"]',
          timeout: 30000
        })
      await checkpoint(
        ctx,
        'swapped',
        {
          readBack: async () => {
            expect(
              await until(60000, async () => {
                const game = (await asCoach(
                  ctx,
                  world,
                  `/games/${world.game}`
                )) as { homeTeamId?: string }
                return game.homeTeamId === world.awayTeam
              }),
              'the server holds the sides swapped'
            ).equals(true)
          }
        },
        app.m
      )
    },
    'offline-scoring': async ctx => {
      const setFault = ctx.stack.setFault
      if (setFault == null)
        throw new BlockedError('needs a stack whose fault server can be set')
      const world = await worldOf(ctx)
      const app = await openWebApp(ctx, 'scorekeeper')
      const shot = async (name: string): Promise<void> => {
        await app.m.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
      }
      await openScoring(app, world)
      await app.m.tapOn(BALL)
      expect(
        await until(20000, async () =>
          (await callsOnServer(ctx, world)).includes('B')
        ),
        'the online Ball on the server'
      ).equals(true)
      await shot('online-ball')
      let cleared = false
      await setFault('api-hang')
      try {
        // No answer from here: score, leave, come back, score again. Inside
        // the app: a page load would empty the tab's in-memory copy, which
        // nothing outlives (#358).
        await app.m.tapOn(BALL)
        await sleep(1500)
        await shot('offline-ball')
        await app.m.tapOn({ text: 'Open scoring menu' })
        await app.m.tapOn({ text: 'Exit Current Game' })
        await app.m.assertVisible({ text: 'Score', timeout: 30000 })
        await shot('offline-left')
        await sleep(2000)
        await app.m.tapOn({ text: 'Score' })
        await app.m.assertVisible({ text: 'Full game scoring', timeout: 30000 })
        const started = Date.now()
        await app.m.tapOn({ text: 'Full game scoring' })
        await app.m.extendedWaitUntil({
          // The pad's button and the last play's row: the plays came back.
          visible: { text: 'Ball', index: 1 },
          timeout: 30000
        })
        const opened = Date.now() - started
        await sleep(1500)
        if (ctx.surface === 'web-chromium')
          await app.m.assertVisible({
            css: '[data-testid="scoringNotice"]',
            timeout: 30000
          })
        await shot('offline-return')
        await checkpoint(
          ctx,
          'offline-return',
          { expect: [{ text: 'Ball' }] },
          app.m
        )
        expect(opened, 'scoring opened from the tab’s copy').lessThan(15000)
        // Android's Chrome can leave the pad out of what it reports right
        // after the return; the pad sits at the window's foot, so the
        // button is tapped at its place there. The server's read-back
        // below proves it was a called strike.
        await app.m
          .tapOn({ text: 'Called Strike', timeout: 5000 })
          .catch(async () => await app.m.tapOn({ point: '30%,89%' }))
        await sleep(1500)
        await setFault(null)
        cleared = true
      } finally {
        if (!cleared) await setFault(null)
      }
      await checkpoint(
        ctx,
        'online-again',
        {
          readBack: async () => {
            expect(
              await until(60000, async () => {
                const calls = await callsOnServer(ctx, world)
                return calls.join('') === 'BBC'
              }),
              'every pitch on the server, in order'
            ).equals(true)
          }
        },
        app.m
      )
    },
    chat: async ctx => {
      const world = await worldOf(ctx)
      const app = await openWebApp(ctx, 'coach')
      // A fresh coach confirms their age on the team's Chats screen.
      const chats = `/teams/${world.homeTeam}?tab=chats`
      await app.go(chats)
      const declared: boolean = await app.m
        .tapOn({ text: 'I’m 18 or Older', timeout: 20000 })
        .then(
          () => true,
          () => false
        )
      if (declared) {
        await app.m.extendedWaitUntil({
          notVisible: { text: 'Your Age' },
          timeout: 10000
        })
        await app.go(chats)
      }
      await app.m.tapOn({ text: 'Staff', timeout: 30000 })
      // And, once, whether to send notifications.
      await app.m
        .tapOn({ text: 'Not Now', timeout: 10000 })
        .catch(() => undefined)
      const words = `Main flow ${Date.now().toString(36)}`
      await app.type('Message', words)
      await app.m.hideKeyboard().catch(() => undefined)
      const send =
        ctx.surface === 'web-chromium'
          ? { css: '[aria-label="Send"]:not([aria-disabled="true"])' }
          : // Safari names the button; Android's Chrome reads its label.
            ctx.surface === 'web-safari-ios'
            ? { id: 'Send' }
            : { text: 'Send' }
      // Sent: the conversation holds it, so its empty state has gone. On a
      // phone the first tap can go to putting the keyboard away; tapped
      // again while the message is still unsent.
      for (let tap = 0; ; tap++) {
        await app.m.tapOn(send)
        const sent: boolean = await app.m
          .extendedWaitUntil({
            notVisible: { text: 'No messages yet' },
            timeout: 10000
          })
          .then(
            () => true,
            () => false
          )
        if (sent) break
        if (tap === 2) throw new Error('the message was not sent')
      }
      await checkpoint(
        ctx,
        'chat-sent',
        {
          expect: [
            { text: `.*${words}.*`, timeout: 30000 },
            { text: '.*Sent.*' }
          ]
        },
        app.m
      )
    },
    video: async ctx => {
      // A game with two videos, as the streaming scripts' world has.
      const streaming = await ctx.fixture('streaming')
      rememberAccounts(streaming)
      const app = await openWebApp(ctx, 'coach')
      await app.go(`/games/${streaming.ids.gameWithVideos}?tab=watch`)
      // The game's video opens on its first angle, with the other offered.
      // The world's videos have no media uploaded, so the player says so;
      // playback itself is the streaming scenarios' (rapid-scrub, long-cuts).
      await checkpoint(
        ctx,
        'game-video',
        {
          expect: [
            { text: 'Home Plate', timeout: 30000 },
            { text: 'First Base' },
            { text: 'All angles' }
          ]
        },
        app.m
      )
    },
    season: async ctx => {
      const league = await ctx.fixture('packed-league')
      rememberAccounts(league)
      const [name, seasonId] = Object.entries(league.ids).find(([, id]) =>
        id.startsWith('sea')
      )!
      const app = await openWebApp(ctx, 'admin')
      await app.go(`/seasons/${seasonId}`)
      await checkpoint(
        ctx,
        'season-page',
        {
          expect: [
            { text: name, timeout: 30000 },
            { text: 'Standings' },
            { text: `${name} Team 1.*` }
          ]
        },
        app.m
      )
    }
  }
})
