import { expect } from 'chai'

import { readJson } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext } from '../../../core/spec'
import {
  type CoachApp,
  DEVELOP_APP,
  labelOf,
  openCoachApp,
  stackDatabaseUrl
} from '../../../rigs/coach/coachApp'

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
  scorekeeper: string
  coach: { email: string; password: string }
}

async function worldOf(ctx: E2eContext): Promise<World> {
  const world = await ctx.fixture('coach-game')
  const coach = world.accounts.coach
  return {
    game: world.ids.game,
    homeTeam: world.ids.homeTeam,
    scorekeeper: world.accounts.scorekeeper.userId,
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
      [world.scorekeeper, world.homeTeam]
    )
    expect(removed.rowCount, 'the scorekeeper role row').equals(1)
  } finally {
    await client.end()
  }
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
  await app.m.openLink({ link: `teamstation://games/${world.game}/score` })
  await app.m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: 60000 })
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
  await app.m.tapOn({ text: 'Ball' })
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
  await m.tapOn({ text: 'Create Player' })
  // The sheet's fields share their names with their labels, and the
  // keyboard moves the sheet: the first field is tapped where it opens and
  // Return carries on to the next (as `mobile/test/offlineSync.e2e.ts`).
  await m.tapOn({ point: '26%,30%' })
  await m.inputText({ text: 'Held\n' })
  await m.inputText({ text: 'Player\n' })
  await m.tapOn({ text: 'Done' })
  // Create Player is also the sheet's title and the button behind it.
  await m.tapOn({ point: '50%,77%' })
  await m.extendedWaitUntil({ visible: { text: 'Held P' }, timeout: 15000 })
  await m.tapOn({ text: 'Close' })
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
  await openScoring(app, world)
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

async function shot(
  ctx: E2eContext,
  app: CoachApp,
  name: string
): Promise<void> {
  await app.m.takeScreenshot({ path: ctx.artifact(name) })
}

/** Whether a node with this id is on screen. */
async function shown(app: CoachApp, id: string): Promise<boolean> {
  return (await app.nodes()).some(node => node.id === id)
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
      const app = await openCoachApp(ctx, 'scorekeeper')
      await refuse(ctx, app, world, tapBall)
      await ctx.checkpoint(
        'banner-held',
        { expect: [{ id: 'offlineBanner', timeout: 30000 }] },
        app.m
      )
      await shot(ctx, app, 'banner-held.png')
      await shot(ctx, app, 'game-held.png')
      const team = await worldOf(ctx)
      const second = await openCoachApp(ctx, 'scorekeeper')
      await refuse(ctx, second, team, createPlayer)
      await second.openTeam(team.homeTeam)
      await second.m.extendedWaitUntil({
        visible: { text: 'Roster' },
        timeout: 30000
      })
      await shot(ctx, second, 'team-held.png')
    },
    'clear-from-banner': async ctx => {
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, 'scorekeeper')
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
      const app = await openCoachApp(ctx, 'scorekeeper')
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
      // The server's copy: the scorekeeper no longer scores this game.
      await app.m.extendedWaitUntil({
        visible: { id: 'game-hero-actions' },
        timeout: 30000
      })
      expect(await app.heroActions()).not.includes('Score')
    },
    'clear-from-team': async ctx => {
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, 'scorekeeper')
      await refuse(ctx, app, world, createPlayer)
      await app.openTeam(world.homeTeam)
      await ctx.checkpoint(
        'team-notice',
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
      expect(await shown(app, 'heldTeamMessage')).equals(false)
      expect((await app.nodes()).map(labelOf)).not.includes('Held P')
    }
  }
})
