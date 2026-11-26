import { expect } from 'chai'

import { navTabId } from '../../../../src/test/navTab.e2e'
import type { FixtureAccount } from '../../../core/fixtures'
import { readJson } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { loadSettings } from '../../../core/settings'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { typeInto } from '../../../core/typeInto'
import { appLink } from '../../../rigs/app/setServer'
import {
  type CoachApp,
  DEVELOP_APP,
  labelOf,
  openCoachApp,
  openFullGameScoring,
  stackDatabaseUrl
} from '../../../rigs/coach/coachApp'
import { loadShaper } from '../../../rigs/streaming/shaper'

/**
 * A scorekeeper's edit the server refuses on the phone, and the ways out:
 * the not-sent banner's list, the Game screen's notice, and the Team page's.
 *
 * The refusal is real. The scorekeeper's write is held by the stack's fault
 * server (`api-hang`) while their role on the team is taken away; the hold
 * is let go, which the phone answers as no signal, and the send it retries
 * once the app is back in front reaches the API, which refuses it (403).
 */

/** Who acts, and on what, in the `coach-game` world. */
interface World {
  game: string
  homeTeam: string
  scorekeeper: FixtureAccount
  coach: { email: string; password: string }
}

async function worldOf(ctx: E2eContext): Promise<World> {
  const world = await ctx.fixture('coach-game')
  const coach = world.accounts.coach
  return {
    game: world.ids.game,
    homeTeam: world.ids.homeTeam,
    scorekeeper: world.accounts.scorekeeper,
    coach: { email: coach.email, password: coach.password }
  }
}

/** Takes the scorekeeper's role on the home team away, on the stack. */
async function removeScorekeeper(ctx: E2eContext, world: World): Promise<void> {
  const { Client } = await import('pg')
  const client = new Client({
    connectionString: await stackDatabaseUrl(ctx),
    connectionTimeoutMillis: 15_000
  })
  await client.connect()
  try {
    const removed = await client.query(
      "delete from scope_roles where user_id = $1 and scope_type = 'team' and scope_id = $2 and role = 'scorekeeper'",
      [world.scorekeeper.userId, world.homeTeam]
    )
    expect(removed.rowCount, 'the scorekeeper role row').equals(1)
  } finally {
    await client.end()
  }
}

/** Whether a node with this id is on screen. */
async function shownId(app: CoachApp, id: string): Promise<boolean> {
  return (await app.nodes()).some(node => node.id === id)
}

/** Reads `path` from the stack's API as the home team's coach. */
async function asCoach(
  ctx: E2eContext,
  world: World,
  path: string
): Promise<unknown> {
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  const token = await signInTestAccount(
    `${ctx.stack.origin}/api/v1`,
    world.coach
  )
  return await readJson(ctx.stack.origin, `/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` }
  })
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The Score screen of the game, from its address. */
async function openScoring(app: CoachApp, world: World): Promise<void> {
  await app.m.openLink({ link: appLink(`games/${world.game}/score`) })
  // The Undo row can describe a ball before the scoring control is ready.
  await app.m.extendedWaitUntil({ visible: { id: 'Ball' }, timeout: 60000 })
  // The action pad appears before the field loads the current game.
  await app.m.extendedWaitUntil({
    visible: { id: 'field-nameplate' },
    timeout: 30000
  })
}

/** Leaves the Score screen for the game's page. */
async function exitScoring(app: CoachApp, world: World): Promise<void> {
  await app.m.tapOn({ text: 'Open scoring menu' })
  await app.m.tapOn({ text: 'Exit Current Game' })
  await app.openGame(world.game)
}

/** One write the scoring screen makes, which the server is to refuse. */
type Act = (app: CoachApp) => Promise<void>

const tapBall: Act = async app => {
  await app.m.tapOn({ id: 'Ball' })
  await sleep(1500)
}

/**
 * A new player made for the home team from Set Team Rosters, and left out
 * of every lineup: only the team's queue holds a write for him, so taking
 * the team's server copy leaves no game parked behind him.
 */
const createPlayer: Act = async app => {
  const { m } = app
  await m.tapOn({ text: 'Open scoring menu' })
  await m.tapOn({ text: 'Set Team Rosters' })
  // Create Player is under the home roster's rows.
  await m.scrollUntilVisible({
    element: { text: 'Create Player' },
    direction: 'DOWN'
  })
  await m.tapOn({ text: 'Create Player' })
  // WebDriverAgent can drop a key from a whole string; `typeInto` reads the
  // field back and types a short one again a character at a time.
  await typeInto(m, 'First Name', 'Held')
  await typeInto(m, 'Last Name', 'Player')
  await m.hideKeyboard()
  // Create Player is also the sheet's title and the button behind it.
  await m.tapOn({ point: '50%,77%' })
  await m.extendedWaitUntil({ visible: { text: 'Held P' }, timeout: 15000 })
  // Left out of the lineups: the rosters sheet closes unsaved.
  await m.tapOn({ text: 'Cancel' })
  await m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: 15000 })
}

/**
 * Has the server refuse `act`'s write: held by the fault server while the
 * scorekeeper's role goes, let go (no signal, to the phone), and sent again
 * once the app comes back to the front. Ends on the game's page.
 */
async function refuse(
  ctx: E2eContext,
  app: CoachApp,
  world: World,
  act: Act
): Promise<void> {
  const setFault = ctx.stack.setFault
  if (setFault == null)
    throw new BlockedError('needs a stack whose fault server can be set')
  await openFullGameScoring(app, world.game)
  await setFault('api-hang')
  try {
    await act(app)
    await removeScorekeeper(ctx, world)
  } finally {
    await setFault(null)
  }
  await exitScoring(app, world)
  // Behind and back in front: the queue sends again.
  await app.m.pressKey({ key: 'home' })
  await sleep(2000)
  await app.m.launchApp({ appId: DEVELOP_APP, stopApp: false })
  await app.m.extendedWaitUntil({
    visible: { id: 'offlineBanner' },
    timeout: 90000
  })
}

/** The home team's page on its Team tab: its roster, the phone's copy. */
async function openRoster(app: CoachApp, world: World): Promise<void> {
  await app.openTeam(world.homeTeam)
  await app.m.extendedWaitUntil({
    visible: { id: 'team-hero-words' },
    timeout: 30000
  })
  await app.m.tapOn({ text: 'Team' })
  // Read: the roster's players section is drawn.
  await app.m.extendedWaitUntil({
    visible: { text: 'PLAYERS|Players' },
    timeout: 30000
  })
}

/** Scrolls the roster to the refused player; whether he is listed. */
async function rosterListsHeldPlayer(app: CoachApp): Promise<boolean> {
  try {
    await app.m.scrollUntilVisible({
      element: { text: 'Held P.*' },
      direction: 'DOWN',
      maxScrolls: 8
    })
    return true
  } catch {
    return false
  }
}

/** How many pitches the server holds for the game, read as the coach. */
async function pitchesOnServer(ctx: E2eContext, world: World): Promise<number> {
  const events = await asCoach(ctx, world, `/games/${world.game}/events`)
  return (JSON.stringify(events).match(/"isPitch":true/g) ?? []).length
}

/**
 * The bench's conditioner and the leased iPhone's address on its shaped
 * network, from the local settings' `soak` block (`shaper`, and
 * `shapedIps.iphone`): bench-private, never this repository's.
 */
function phoneOutage(): {
  ip: string
  outage: ReturnType<typeof loadShaper>['outage']
  onTestNetwork: ReturnType<typeof loadShaper>['onTestNetwork']
} {
  const soak = (loadSettings() as { soak?: unknown }).soak as
    { shaper?: unknown; shapedIps?: Record<string, unknown> } | undefined
  const ip = soak?.shapedIps?.iphone
  if (typeof soak?.shaper !== 'string' || typeof ip !== 'string')
    throw new BlockedError(
      'needs soak.shaper and soak.shapedIps.iphone in the local settings'
    )
  const shaper = loadShaper(soak.shaper)
  return { ip, outage: shaper.outage, onTestNetwork: shaper.onTestNetwork }
}

async function shot(
  ctx: E2eContext,
  app: CoachApp,
  name: string
): Promise<void> {
  await app.m.takeScreenshot({ path: ctx.artifact(name) })
}

export default defineE2e({
  id: 'platform/offline/held-edits',
  title:
    'An edit the server refused is listed from the banner and cleared there, on the Game screen and on the Team page',
  kind: 'e2e',
  covers: [
    'src/app/sync/useOffline.ts',
    'src/app/sync/cachingClient.ts',
    'src/app/components/OfflineBanner.tsx',
    'src/app/components/HeldEditsSheet.tsx',
    'src/app/scoring/HeldGameNotice.tsx',
    'src/app/screens/GameScreen.tsx',
    'src/app/screens/TeamScreen.tsx',
    'src/app/App.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'device', needs: ['ios'], hardware: 'none' }]
    }
  },
  services: ['web', 'api'],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 12,
  guards: [],
  // The scenarios set and clear `api-hang` themselves, as setup.
  faults: [],
  manual: false,
  scenarios: {
    // Taps nothing this work adds, so it runs on the base build too: the
    // before and after screenshots.
    'refused-state': async ctx => {
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, world.scorekeeper)
      // One refusal for both: a new player for the team and a Ball for the
      // game, held together while the role goes.
      await refuse(ctx, app, world, async held => {
        await createPlayer(held)
        await tapBall(held)
      })
      // The game's page as it opens, its hero first.
      await shot(ctx, app, 'game-held.png')
      // The banner on Home, a page of its own that says nothing held.
      const nodes = await app.nodes()
      const homeId = navTabId('home')
      if (nodes.some(node => node.id === homeId))
        await app.m.tapOn({ id: homeId })
      else {
        // The base build exposes only the accessible label. Match the tab in
        // the bottom navigation row so game content named Home cannot win.
        const window = await app.window()
        const tab = nodes.find(
          node =>
            labelOf(node) === 'Home' &&
            node.bounds != null &&
            node.bounds.y > window.y + window.height * 0.75
        )?.bounds
        if (tab == null) throw new Error('Missing legacy Home tab')
        await app.m.tapOn({
          point:
            Math.round(tab.x + tab.width / 2) +
            ',' +
            Math.round(tab.y + tab.height / 2)
        })
      }
      await ctx.checkpoint(
        'banner-held',
        { expect: [{ id: 'offlineBanner', timeout: 30000 }] },
        app.m
      )
      await shot(ctx, app, 'banner-held.png')
      await openRoster(app, world)
      await shot(ctx, app, 'team-held.png')
    },
    'clear-from-banner': async ctx => {
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, world.scorekeeper)
      await refuse(ctx, app, world, tapBall)
      await ctx.checkpoint(
        'banner-is-a-button',
        { expect: [{ id: 'offlineBannerButton', timeout: 30000 }] },
        app.m
      )
      await app.m.tapOn({ id: 'offlineBannerButton' })
      const row = `heldEdit-game-${world.game}`
      await ctx.checkpoint('held-list', { expect: [{ id: row }] }, app.m)
      const label = (await app.nodes())
        .map(labelOf)
        .find(text => text.startsWith("Use Server's Copy, "))
      expect(label, 'the row names the game').match(/ @ /)
      const texts = (await app.nodes()).map(labelOf).join('\n')
      expect(texts).includes('Not sent: ')
      await shot(ctx, app, 'held-sheet.png')
      await app.m.tapOn({ text: label! })
      await ctx.checkpoint(
        'banner-cleared',
        {
          expect: [
            { id: 'offlineBanner', absent: true, timeout: 30000 },
            { id: 'heldGameNotice', absent: true }
          ],
          readBack: async () => {
            const events = (await asCoach(
              ctx,
              world,
              `/games/${world.game}/events`
            )) as { plays?: unknown[] }
            expect(
              events.plays ?? [],
              'no pitch reached the server'
            ).deep.equals([])
          }
        },
        app.m
      )
      await shot(ctx, app, 'banner-cleared.png')
    },
    'clear-from-game': async ctx => {
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, world.scorekeeper)
      await refuse(ctx, app, world, tapBall)
      await ctx.checkpoint(
        'game-notice',
        { expect: [{ id: 'heldGameNotice', timeout: 30000 }] },
        app.m
      )
      await app.m.tapOn({ id: 'heldGameNotice' })
      await app.m.tapOn({ text: "Use Server's Copy" })
      await ctx.checkpoint(
        'game-cleared',
        {
          expect: [
            { id: 'heldGameNotice', absent: true, timeout: 30000 },
            { id: 'offlineBanner', absent: true }
          ]
        },
        app.m
      )
      // The server's copy: the scorekeeper no longer scores this game, so
      // the hero offers nothing (its row is not drawn at all).
      await app.m.extendedWaitUntil({
        visible: { id: 'event-hero' },
        timeout: 30000
      })
      expect(await app.heroActions()).not.includes('Score')
    },
    // Scoring keeps working with the phone's network cut at the bench's
    // conditioner: no list, sheet or notice stands in its way, and every
    // play reaches the server once the network is back, with nothing held.
    'offline-scoring': async ctx => {
      const network = phoneOutage()
      if ((await network.onTestNetwork(network.ip)) == null)
        throw new BlockedError(`${network.ip} is not on a shaped network`)
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, world.scorekeeper)
      const { m } = app
      await openFullGameScoring(app, world.game)
      await tapBall(app)
      await m.tapOn({ text: 'Called Strike' })
      await sleep(1500)
      await app.m.extendedWaitUntil({
        visible: { text: 'Ball' },
        timeout: 15000
      })
      const before = await pitchesOnServer(ctx, world)
      expect(before, 'the two online pitches reached the server').equals(2)
      // The phone's traffic dropped from here until the network is back;
      // the conditioner clears it whatever happens inside.
      await network.outage(network.ip, 0, async () => {
        await tapBall(app)
        await tapBall(app)
        await m.assertVisible({ id: 'scoringNotice', timeout: 30000 })
        await shot(ctx, app, 'offline-scoring.png')
        // Scoring is in front: nothing held, nothing to tap away.
        expect(await shownId(app, 'heldEditsSheet')).equals(false)
        await exitScoring(app, world)
        await ctx.checkpoint(
          'offline-game-page',
          {
            expect: [
              { id: 'offlineBanner', timeout: 30000 },
              { id: 'offlineBannerButton', absent: true },
              { id: 'heldGameNotice', absent: true }
            ]
          },
          m
        )
        await shot(ctx, app, 'offline-game.png')
        // Back to scoring, from the phone's copy, and on with the game.
        await openScoring(app, world)
        await m.tapOn({ text: 'Called Strike' })
        await sleep(1500)
        await shot(ctx, app, 'offline-return.png')
        expect(await shownId(app, 'heldEditsSheet')).equals(false)
      })
      // The network is back: in front again, the queue sends.
      await m.pressKey({ key: 'home' })
      await sleep(2000)
      await m.launchApp({ appId: DEVELOP_APP, stopApp: false })
      await exitScoring(app, world)
      await ctx.checkpoint(
        'online-again',
        {
          expect: [
            { id: 'offlineBanner', absent: true, timeout: 120000 },
            { id: 'heldGameNotice', absent: true }
          ],
          readBack: async () => {
            expect(
              await pitchesOnServer(ctx, world),
              'every pitch reached the server'
            ).equals(5)
          }
        },
        m
      )
      await shot(ctx, app, 'online-again.png')
    },
    'clear-from-team': async ctx => {
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, world.scorekeeper)
      await refuse(ctx, app, world, createPlayer)
      await openRoster(app, world)
      await ctx.checkpoint(
        'team-notice',
        { expect: [{ id: 'heldTeamNotice', timeout: 30000 }] },
        app.m
      )
      // The phone's copy of the roster still lists the refused player.
      expect(await rosterListsHeldPlayer(app), 'listed while held').equals(true)
      // Back to the top of the page, where the notice sits clear of the
      // header: a scroll that stops as soon as the notice is drawn can leave
      // it under the header, which then takes the tap.
      await openRoster(app, world)
      await ctx.checkpoint(
        'team-notice-top',
        { expect: [{ id: 'heldTeamNotice', timeout: 30000 }] },
        app.m
      )
      await app.m.tapOn({ id: 'heldTeamNotice' })
      await app.m.tapOn({ text: "Use Server's Copy" })
      await ctx.checkpoint(
        'team-cleared',
        {
          expect: [
            { id: 'heldTeamNotice', absent: true, timeout: 30000 },
            { id: 'offlineBanner', absent: true }
          ],
          readBack: async () => {
            const roster = (await asCoach(
              ctx,
              world,
              `/teams/${world.homeTeam}/roster`
            )) as Array<{ shortName?: string }>
            expect(roster.map(row => row.shortName)).not.includes('Held P')
          }
        },
        app.m
      )
      // The page read the server's roster again: the player is gone from it.
      await app.m.extendedWaitUntil({
        visible: { text: 'PLAYERS|Players' },
        timeout: 30000
      })
      expect(await rosterListsHeldPlayer(app), 'gone once cleared').equals(
        false
      )
    }
  }
})
