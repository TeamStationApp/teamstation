import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { sql } from 'kysely'

import { TeamStationClient } from '../../../../src/common/api'
import { makeId } from '../../../../src/common/ids'
import { signInWithPassword } from '../../../core/fixtures'
import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { appLink, openInApp } from '../../../rigs/app/setServer'
import { apiToken } from '../../../rigs/media/recordingSeek'
import {
  acceptReel,
  endLive,
  goLive,
  REEL_MS,
  type ReelSetup,
  reelsRead,
  reelWorld,
  sampleLines,
  samples,
  scorer,
  startSampling
} from '../../../rigs/media/sponsorReelGame'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * E14, sponsor analytics (#220): on the `sponsors` world, with a recorded
 * reel game and an American League row on the Yankees Schedule, the Yankees
 * player watches the reel for 6 s and again for 6 s, keeps the row on screen
 * 6 s and taps it, then has it on screen 3 s, scrolls away and back for 5 s;
 * signed out, the public Yankees page keeps the row on screen 6 s and it is
 * tapped. `analytics.events` on the stack then holds two reel views with the
 * player's id, three row views (two the player's, one with the device id),
 * two taps (the player's and the device's), and nothing for the 3 s stay.
 */

const DESKTOP = { width: 1280, height: 800 }
const APP_ID = 'app.teamstation.develop'
const HOUR = 3_600_000
const run = promisify(execFile)
const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const ROW = {
  title: 'Bayside Bakery',
  message: 'Fresh bread after every game.',
  url: 'https://example.test/bread'
}
/** The row's title, as a page shows it. */
const ROW_TITLE = ROW.title
const ffmpeg = (): string => process.env.TS_FFMPEG ?? 'ffmpeg'

/** A still picture made with ffmpeg at `path`. */
async function picture(
  path: string,
  width: number,
  height: number,
  source: string
): Promise<Uint8Array> {
  await run(ffmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `${source}${source.includes('=') ? ':' : '='}s=${width}x${height}`,
    '-frames:v',
    '1',
    path
  ])
  return new Uint8Array(readFileSync(path))
}

/**
 * The AL admin's row two hours after Dodgers @ Yankees, and twenty more
 * Yankees games a day apart after that, so the Schedule is long enough to
 * scroll the row out of sight. The row is after the next game, where a
 * signed-in Schedule opens, so it is in the first page the Schedule reads.
 * Answers the row's id.
 */
async function placeRow(ctx: E2eContext, setup: ReelSetup): Promise<string> {
  const { world, db } = setup
  const { start_at: home } = await db
    .selectFrom('games')
    .select('start_at')
    .where('id', '=', world.ids.dodgersAtYankees)
    .executeTakeFirstOrThrow()
  const homeAt = new Date(home).getTime()
  await db
    .insertInto('games')
    .values(
      Array.from({ length: 20 }, (_v, i) => ({
        id: makeId('game'),
        season_id: world.ids.season,
        home_team_id: world.ids.yankees,
        away_team_id: world.ids.redSox,
        start_at: new Date(homeAt + (i + 1) * 24 * HOUR),
        venue: 'Sponsor Field',
        status: 'scheduled' as const
      }))
    )
    .execute()
  const handle = stackHandle(ctx)
  const league = world.ids.americanLeague
  const api = new TeamStationClient({
    baseUrl: handle.api,
    token: await apiToken(handle.api, world.accounts.alAdmin)
  })
  const upload = async (
    purpose: 'rowLogo' | 'rowBackground',
    width: number,
    height: number,
    source: string
  ): Promise<string> =>
    (
      await api.uploadSponsorMedia(
        league,
        purpose,
        'image/png',
        await picture(join(ctx.runDir, `${purpose}.png`), width, height, source)
      )
    ).mediaId
  const state = await api.addSponsorRow(league, {
    logoMediaId: await upload('rowLogo', 128, 128, 'color=c=orange'),
    backgroundMediaId: await upload('rowBackground', 1920, 224, 'testsrc2'),
    ...ROW,
    textColor: 'white',
    startsAt: new Date(homeAt + 2 * HOUR).toISOString()
  })
  const placed = state.placements.find(one => one.title === ROW.title)
  expect(placed, 'the placed row').not.equals(undefined)
  return placed!.id
}

/**
 * The recorded reel game: live with a half-inning's reel, then finished.
 * Answers its first camera, the reel's placement and where it starts in
 * that camera's recording, in seconds.
 */
async function recordedReel(
  ctx: E2eContext,
  setup: ReelSetup
): Promise<{
  video: string
  placement: { id: string; reelId: string; startMs: number }
  startSec: number
}> {
  await acceptReel(ctx, setup)
  const { cameras, videos } = await goLive(ctx, setup, 60 * 60_000)
  let placement: { id: string; reelId: string; startMs: number }
  try {
    await wait(30_000)
    await (await scorer(setup)).endHalf()
    placement = (await reelsRead(setup, 1, 30_000)).reels[0]
    await wait(Math.max(0, placement.startMs + REEL_MS + 20_000 - Date.now()))
  } finally {
    await endLive(setup, cameras)
  }
  const video = await setup.db
    .selectFrom('videos')
    .select(['id', 'start_at'])
    .where('id', '=', videos[0])
    .executeTakeFirstOrThrow()
  return {
    video: video.id,
    placement: placement!,
    startSec:
      (placement!.startMs - new Date(video.start_at ?? 0).getTime()) / 1000
  }
}

/**
 * This run's sponsor events in the stack's analytics, its game's and its
 * row's, as `psql` prints them.
 */
async function eventsLog(setup: ReelSetup, rowId: string): Promise<string> {
  const safe = (id: string): string => id.replace(/[^\w-]/g, '')
  const query = `select event_name, user_id, properties from analytics.events where event_name like 'sponsor_%' and (properties->>'gm' = '${safe(setup.gameId)}' or properties->>'er' = '${safe(rowId)}') order by occurred_at`
  const { stdout } = await run('psql', [setup.psqlUrl, '-c', query])
  return `$ psql "$STACK_DATABASE_URL" -c "${query}"\n${stdout}`
}

/**
 * Clears the stack's password sign-in limits: production's five tries in
 * fifteen minutes from one address, which this Mac's runs share.
 */
async function clearSignInLimits(setup: ReelSetup): Promise<void> {
  await sql`delete from rate_events where scope like 'password.%' or scope like 'passwordParameters.%'`.execute(
    setup.db
  )
}

interface Stored {
  event_name: string
  user_id: string | null
  properties: Record<string, unknown>
}

/** Waits for the expected sponsor events to be stored, and checks them. */
async function expectStored(
  setup: ReelSetup,
  ids: { player: string; row: string; reel: { id: string; reelId: string } }
): Promise<Stored[]> {
  let rows: Stored[] = []
  await eventually(async () => {
    rows = (
      await sql<Stored>`select event_name, user_id, properties from analytics.events where event_name like 'sponsor_%' and (properties->>'gm' = ${setup.gameId} or properties->>'er' = ${ids.row}) order by occurred_at`.execute(
        setup.db
      )
    ).rows
    const named = (name: string): Stored[] =>
      rows.filter(row => row.event_name === name)
    expect(named('sponsor_reel_viewed'), 'two reel views').length(2)
    expect(named('sponsor_row_viewed'), 'three row views').length(3)
    expect(named('sponsor_row_tapped'), 'two taps').length(2)
  }, 120_000)
  const named = (name: string): Stored[] =>
    rows.filter(row => row.event_name === name)
  for (const view of named('sponsor_reel_viewed')) {
    expect(view.user_id).equals(ids.player)
    expect(view.properties).to.include({
      rp: ids.reel.id,
      rr: ids.reel.reelId,
      gm: setup.gameId,
      lg: setup.league,
      lv: false
    })
    expect(view.properties.at).a('number')
    expect(view.properties).not.to.have.property('dv')
  }
  const rowViews = named('sponsor_row_viewed')
  // The phone is signed out first, the web last: who, not when.
  const who = (list: Array<string | null>): string[] =>
    list.map(user => user ?? 'signed out').sort((a, b) => a.localeCompare(b))
  expect(who(rowViews.map(view => view.user_id))).deep.equals(
    who([ids.player, ids.player, null])
  )
  const taps = named('sponsor_row_tapped')
  expect(who(taps.map(tap => tap.user_id))).deep.equals(who([ids.player, null]))
  for (const event of [...rowViews, ...taps]) {
    expect(event.properties).to.include({ er: ids.row, lg: setup.league })
    if (event.user_id == null) expect(event.properties.dv).a('string')
    else expect(event.properties).not.to.have.property('dv')
  }
  return rows
}

/** The Yankees player signed in on the web through the password form. */
async function playerOnWeb(
  ctx: E2eContext,
  setup: ReelSetup
): Promise<WebSession> {
  const web = await ctx.browser(DESKTOP, { h264: true })
  await web.m.openLink({ link: ctx.stack.origin })
  const account = setup.world.accounts.yankeesPlayer
  await web.m.assertVisible({ text: 'Use a password instead', timeout: 30_000 })
  await web.m.tapOn({ text: 'Use a password instead' })
  await web.m.tapOn({
    css: 'input[aria-label="E-mail address"]',
    timeout: 15_000
  })
  await web.m.inputText({ text: account.email })
  await web.m.tapOn({ css: 'input[aria-label="Password"]', timeout: 15_000 })
  await web.m.inputText({ text: account.password })
  await web.m.pressKey({ key: 'Enter' })
  await eventually(async () => {
    const signedIn = await web.page.evaluate(
      () => document.querySelector('input[aria-label="Password"]') == null
    )
    expect(signedIn, 'the password form has gone').equals(true)
  }, 30_000)
  return web
}

/** Plays the card's game video from `sec`, muted, as a viewer dragging there. */
async function playFrom(web: WebSession, sec: number): Promise<void> {
  await eventually(async () => {
    const ok = await web.page.evaluate(async (at: number) => {
      const video = [...document.querySelectorAll('video')].find(
        one => one.closest('[data-testid="sponsor-reel"]') === null
      )
      if (video == null || video.readyState < 1) return false
      video.muted = true
      video.currentTime = at
      await video.play().catch(() => undefined)
      return !video.paused
    }, sec)
    expect(ok, 'the game is playing').equals(true)
  }, 60_000)
}

/** How long the reel has been drawn, by the page's own clock, ms. */
async function reelShownFor(web: WebSession, ms: number): Promise<void> {
  await web.m.assertVisible({ id: 'sponsor-reel', timeout: 30_000 })
  await wait(ms)
  await web.m.assertVisible({ id: 'sponsor-reel', timeout: 1000 })
}

/** The page's scroller moved so the row is in sight, or far out of it. */
async function scrollRow(web: WebSession, inSight: boolean): Promise<void> {
  await web.page.evaluate((show: boolean) => {
    const row = document.querySelector<HTMLElement>(
      '[data-testid="sponsored-schedule-row"]'
    )
    let scroller: HTMLElement | null = row
    while (
      scroller != null &&
      !(
        scroller.scrollHeight > scroller.clientHeight + 1 &&
        ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement
    // The page has no helpers for `?.` or `??`.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- runs in the page
    const page = scroller != null ? scroller : document.scrollingElement!
    if (show) {
      if (row != null) row.scrollIntoView({ block: 'center' })
    } else page.scrollTop = page.scrollHeight
    page.dispatchEvent(new Event('scroll'))
  }, inSight)
  await wait(500)
}

/** Whether the row is at least half in the window. */
async function rowInSight(web: WebSession): Promise<boolean> {
  return await web.page.evaluate(() => {
    const row = document.querySelector('[data-testid="sponsored-schedule-row"]')
    if (row == null) return false
    const box = row.getBoundingClientRect()
    const seen = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0)
    return seen >= box.height / 2
  })
}

/** Taps the row with the page's `window.open` recorded rather than opened. */
async function tapRow(web: WebSession): Promise<void> {
  await web.page.evaluate(() => {
    const opened: unknown[][] = []
    ;(window as unknown as { opened: unknown[][] }).opened = opened
    window.open = (...args: unknown[]) => {
      opened.push(args)
      return null
    }
  })
  await web.m.tapOn({ css: '[data-testid="sponsored-schedule-row"]' })
  await eventually(async () => {
    const opened = await web.page.evaluate(
      () => (window as unknown as { opened: unknown[][] }).opened
    )
    expect(opened).deep.equals([[ROW.url, '_blank', 'noopener']])
  }, 15_000)
}

/** Sends what the page has queued, as leaving it does. */
async function flushPage(web: WebSession): Promise<void> {
  await web.page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'))
  })
  await wait(1000)
}

/** E14 on the web. */
async function onWeb(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  try {
    const rowId = await placeRow(ctx, setup)
    const game = await recordedReel(ctx, setup)
    await clearSignInLimits(setup)
    const web = await playerOnWeb(ctx, setup)

    // The reel, 6 s, then again from its start for 6 s. The card plays
    // from the link's time by itself, well before the reel, while the page
    // loads; the viewer then drags to a second before it.
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?video=${game.video}&t=${Math.max(0, game.startSec - 30).toFixed(1)}`
    })
    const steps: string[] = []
    const step = (name: string): void => {
      steps.push(`${new Date().toISOString()} ${name}`)
    }
    await startSampling(web)
    const began = Date.now()
    step('open')
    await playFrom(web, Math.max(0, game.startSec - 1))
    step('playing')
    await reelShownFor(web, 6500)
    step('watched')
    await web.m.takeScreenshot({ path: ctx.artifact('reel-viewed-web.png') })
    await playFrom(web, Math.max(0, game.startSec - 2))
    await eventually(async () => {
      expect(
        await web.page.evaluate(
          () => document.querySelector('[data-testid="sponsor-reel"]') == null
        ),
        'the reel off before it starts again'
      ).equals(true)
    }, 10_000)
    step('replaying')
    await reelShownFor(web, 6500)
    step('watched again')
    appendFileSync(
      ctx.artifact('reel-views-web.log'),
      `${steps.join('\n')}\n${sampleLines(await samples(web), began)}\n`
    )

    // The row: 6 s and a tap; then 3 s, away, and back for 5 s.
    await web.m.openLink({
      link: `${ctx.stack.origin}/teams/${setup.world.ids.yankees}?tab=schedule`
    })
    await web.m.assertVisible({ text: ROW_TITLE, timeout: 45_000 })
    await scrollRow(web, true)
    expect(await rowInSight(web), 'the row on screen').equals(true)
    await wait(6500)
    await web.m.takeScreenshot({ path: ctx.artifact('row-viewed-web.png') })
    await tapRow(web)
    await scrollRow(web, false)
    expect(await rowInSight(web), 'the row scrolled away').equals(false)
    await wait(1000)
    await scrollRow(web, true)
    expect(await rowInSight(web)).equals(true)
    await wait(3000)
    await scrollRow(web, false)
    expect(await rowInSight(web)).equals(false)
    await wait(3000)
    await scrollRow(web, true)
    await wait(5500)
    await flushPage(web)
    await web.close()

    // Signed out: the public page, 6 s and a tap.
    const visitor = await ctx.browser(DESKTOP)
    await visitor.m.openLink({
      link: `${ctx.stack.origin}/teams/${setup.world.ids.yankees}?tab=schedule`
    })
    await visitor.m.assertVisible({ text: ROW_TITLE, timeout: 45_000 })
    await scrollRow(visitor, true)
    await wait(6500)
    await tapRow(visitor)
    await flushPage(visitor)
    await visitor.close()

    await expectStored(setup, {
      player: setup.world.accounts.yankeesPlayer.userId,
      row: rowId,
      reel: game.placement
    })
    appendFileSync(
      ctx.artifact('analytics-events.log'),
      `## ${ctx.scenarioId} (${new Date().toISOString()})\n${await eventsLog(setup, rowId)}\n`
    )
  } finally {
    await setup.db.destroy()
  }
}

/** E14 on the iPhone app: the same viewing, signed in, on the phone. */
async function onIosApp(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'ios-app')
    throw new BlockedError(`runs on ios-app, not ${ctx.surface}`)
  const udid = ctx.device('phone')
  const setup = await reelWorld(ctx)
  try {
    const rowId = await placeRow(ctx, setup)
    const game = await recordedReel(ctx, setup)
    const device = await ctx.attach('phone', { platform: 'ios', appId: APP_ID })
    const open = async (path: string): Promise<void> => {
      await openInApp({
        platform: 'ios',
        udid,
        appId: APP_ID,
        link: appLink(path),
        device,
        simulator: true
      })
    }
    const schedule = `teams/${setup.world.ids.yankees}?tab=schedule`
    /** The row on screen: the Schedule settles on its next game first. */
    /**
     * Taps the row until Safari has its address: a tap while an older page of
     * the Schedule lands can find the row moved from under it.
     */
    const tapOnPhone = async (): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        await device.scrollUntilVisible({
          element: { id: 'sponsored-schedule-row' },
          direction: 'UP',
          timeout: 30_000
        })
        await device.tapOn({ id: 'sponsored-schedule-row' })
        try {
          await device.assertVisible({
            text: '.*example\\.test.*',
            timeout: attempt === 3 ? 30_000 : 10_000
          })
          return
        } catch (error) {
          if (attempt === 3) throw error
        }
      }
    }
    const rowOnScreen = async (): Promise<void> => {
      await device.assertVisible({ text: 'Dodgers.*', timeout: 60_000 })
      await wait(1500)
      await device.scrollUntilVisible({
        element: { id: 'sponsored-schedule-row' },
        timeout: 30_000
      })
    }

    // Signed out first: the public Yankees page, 6 s and a tap.
    await device.launchApp({ appId: APP_ID, stopApp: true })
    await open(schedule)
    await rowOnScreen()
    await wait(6500)
    await tapOnPhone()
    // Fresh, at the sign-in screen; going to Safari sent what was queued.
    await device.launchApp({ appId: APP_ID, stopApp: true })
    // A tap in the first moments of a launch can land before the screen
    // takes it.
    await device.assertVisible({
      text: 'Sign in to TeamStation',
      timeout: 30_000
    })
    await wait(3000)
    await clearSignInLimits(setup)
    await signInWithPassword(device, setup.world.accounts.yankeesPlayer)
    // The reel, 6 s, then again from its start.
    for (let play = 0; play < 2; play++) {
      await open(
        `games/${setup.gameId}?angles=${game.video}&t=${Math.max(0, game.startSec - 1).toFixed(1)}`
      )
      await device.assertVisible({ id: 'sponsor-reel', timeout: 60_000 })
      await wait(6500)
      await device.assertVisible({ id: 'sponsor-reel', timeout: 1000 })
      if (play === 0)
        await device.takeScreenshot({
          path: ctx.artifact('reel-viewed-ios.png')
        })
      // Out of the reel before the next play of it.
      await open(
        `games/${setup.gameId}?angles=${game.video}&t=${Math.max(0, game.startSec + REEL_MS / 1000 + 3).toFixed(1)}`
      )
      await device.assertNotVisible({ id: 'sponsor-reel', timeout: 30_000 })
    }

    // The row: 6 s and a tap; then 3 s, away, and back for 5 s.
    await open(schedule)
    await rowOnScreen()
    await wait(6500)
    await device.takeScreenshot({ path: ctx.artifact('row-viewed-ios.png') })
    await tapOnPhone()
    // Back from Safari, the app opens on its home: the Schedule again, the
    // row on screen under 5 s before it is scrolled away, and back for 5 s.
    await device.launchApp({ appId: APP_ID })
    await open(schedule)
    // Away as soon as it is there: the phone's swipes are slow.
    await device.assertVisible({
      id: 'sponsored-schedule-row',
      timeout: 60_000
    })
    const shown = Date.now()
    for (let i = 0; i < 2; i++)
      await device.swipe({ start: '50%,85%', end: '50%,10%', duration: 200 })
    await device.assertNotVisible({
      id: 'sponsored-schedule-row',
      timeout: 5000
    })
    appendFileSync(
      ctx.artifact('short-stay-ios.log'),
      `the row on screen for under ${Date.now() - shown} ms before it left\n`
    )
    await wait(3000)
    await device.scrollUntilVisible({
      element: { id: 'sponsored-schedule-row' },
      direction: 'UP',
      timeout: 60_000
    })
    await wait(5500)
    // Backgrounded, the app sends what it has queued.
    await device.pressKey({ key: 'home' })

    await expectStored(setup, {
      player: setup.world.accounts.yankeesPlayer.userId,
      row: rowId,
      reel: game.placement
    })
    appendFileSync(
      ctx.artifact('analytics-events.log'),
      `## ${ctx.scenarioId} (${new Date().toISOString()})\n${await eventsLog(setup, rowId)}\n`
    )
  } finally {
    await setup.db.destroy()
  }
}

export default defineE2e({
  id: 'platform/analytics/sponsor-events',
  title:
    'Sponsor reel views, sponsored row views and taps are recorded with the viewer, or the device when signed out',
  kind: 'e2e',
  covers: [
    'src/common/observability/contract.ts',
    'src/app/player/sponsors/useReelViews.ts',
    'src/app/sponsors/viewTimers.ts',
    'src/app/sponsors/sponsorRowEvents.ts',
    'src/app/sponsors/SponsoredScheduleRow.tsx',
    'src/app/components/usePagedFollow.ts',
    'src/app/observability/AnalyticsContext.tsx'
  ],
  stack: 'isolated',
  fixtures: ['sponsors'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    }
  },
  services: ['web'],
  // The phone runs a local build of this branch (Devices, in the plan).
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 8,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    web: onWeb,
    'ios-app': onIosApp
  }
})
