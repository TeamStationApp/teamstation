import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'

import { TeamStationClient } from '../../../../src/common/api'
import type { LogoPlacement } from '../../../../src/common/nodeSettings'
import type { GameSponsors } from '../../../../src/common/sponsors/types'
import { type Database, makeDatabase } from '../../../../src/server/db/database'
import type { FixtureManifest } from '../../../../src/server/dev/fixtures/accounts'
import { LOGO_SETTLE_MS } from '../../../../src/server/sponsors/logos'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { signInWithPassword } from '../../../core/fixtures'
import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { appLink, openInApp } from '../../../rigs/app/setServer'
import { apiToken } from '../../../rigs/media/recordingSeek'
import { publishGame, recordGame } from '../../../rigs/media/sponsorRecordings'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * A game's sponsor logo (#220): the American League accepts a logo through
 * the API, and the game it sponsors is given it when its first recording
 * begins — a live publish through `beganPublishing`, or an upload through
 * `ingestVideoFile`. Its players draw it in the upper right of every video
 * from the first frame. It uses one of the league's credits once the game
 * has been recorded for 30 minutes (the stack's minute settle), never for a
 * playback; a shorter game keeps it for nothing, and a game begun with no
 * credits, or before the logo was accepted, has none.
 *
 * The web runs Chrome (`h264`); the iPhone scenario needs a branch build on
 * the leased simulator, pointed at the stack (`e2e/rigs/app/setServer.ts`).
 * `logo-credits.log` keeps each step's `psql` reads of the placements.
 */

const DESKTOP = { width: 1280, height: 800 }
const APP_ID = 'app.teamstation.develop'
/** The stack sweeps every minute; a settle is seen inside two. */
const SETTLE_MS = 150_000

const run = promisify(execFile)
const ffmpeg = (): string => process.env.TS_FFMPEG ?? 'ffmpeg'

interface Sponsored {
  world: FixtureManifest
  league: string
  /** The AL admin's client, and the Yankees player's. */
  admin: TeamStationClient
  player: TeamStationClient
  db: Kysely<Database>
  /** The stack's database as `psql` takes it, which holds a password. */
  psqlUrl: string
  logoId: string | null
}

/**
 * A logo with a transparent ground, so the video shows round its letters:
 * 480 × 120, the 480 × 270 box's width.
 */
async function logoPng(path: string): Promise<Uint8Array> {
  await run(ffmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x00000000:s=480x120,format=rgba',
    '-vf',
    'drawbox=x=12:y=12:w=456:h=96:color=yellow:t=8:replace=1,drawbox=x=40:y=40:w=400:h=40:color=red:t=fill:replace=1',
    '-frames:v',
    '1',
    path
  ])
  return new Uint8Array(readFileSync(path))
}

/** The `sponsors` world, with the clients and the stack's database. */
async function world(ctx: E2eContext): Promise<Sponsored> {
  const handle = stackHandle(ctx)
  const manifest = await ctx.fixture('sponsors')
  const databaseUrl = nodeDatabaseUrl(handle.databaseUrl)
  return {
    world: manifest,
    league: manifest.ids.americanLeague,
    admin: new TeamStationClient({
      baseUrl: handle.api,
      token: await apiToken(handle.api, manifest.accounts.alAdmin)
    }),
    player: new TeamStationClient({
      baseUrl: handle.api,
      token: await apiToken(handle.api, manifest.accounts.yankeesPlayer)
    }),
    db: makeDatabase(databaseUrl),
    psqlUrl: handle.databaseUrl,
    logoId: null
  }
}

/** The AL admin accepts a 50-game logo through the API. */
async function acceptLogo(ctx: E2eContext, setup: Sponsored): Promise<string> {
  const bytes = await logoPng(ctx.artifact('logo.png'))
  const media = await setup.admin.uploadSponsorMedia(
    setup.league,
    'logo',
    'image/png',
    bytes
  )
  const state = await setup.admin.addSponsorLogo(setup.league, {
    mediaId: media.mediaId,
    name: 'Harbor Bank',
    allocation: 50
  })
  const logo = state.logos.find(one => one.name === 'Harbor Bank')
  expect(logo, 'the accepted logo').not.equals(undefined)
  setup.logoId = logo!.id
  return logo!.id
}

/** When the logo was accepted, by the stack's own clock. */
async function acceptedAt(setup: Sponsored, logoId: string): Promise<Date> {
  const row = await setup.db
    .selectFrom('sponsor_logos')
    .select('accepted_at')
    .where('id', '=', logoId)
    .executeTakeFirstOrThrow()
  return new Date(row.accepted_at)
}

/**
 * The placements and the logo's games as `psql` reads them on the stack's
 * database, appended to `logo-credits.log` under `step`. The command is
 * written without its address, which holds a password.
 */
async function readCredits(
  ctx: E2eContext,
  setup: Sponsored,
  step: string,
  gameIds: string[]
): Promise<void> {
  const games = gameIds.map(id => `'${id.replace(/'/g, '')}'`).join(', ')
  const queries = [
    `select game_id, title, status, to_char(now() - start_at, 'HH24:MI:SS') as recorded from videos where game_id in (${games}) and status = 'live' order by game_id, title`,
    `select game_id, league_id, logo_id, settled_at is not null as settled, charged from game_sponsor_logos where game_id in (${games}) order by game_id, league_id`,
    `select id, name, allocation, used, active from sponsor_logos where league_id = '${setup.league.replace(/'/g, '')}' order by position`
  ]
  let text = `\n## ${ctx.scenarioId}: ${step} (${new Date().toISOString()})\n`
  for (const query of queries) {
    // Its failure is told without the command, which names the address.
    const { stdout } = await run('psql', [setup.psqlUrl, '-c', query]).catch(
      (error: unknown) => {
        const stderr = (error as { stderr?: string }).stderr
        throw new Error(`psql failed: ${stderr ?? 'no output'}`)
      }
    )
    text += `$ psql "$STACK_DATABASE_URL" -c "${query}"\n${stdout}`
  }
  appendFileSync(ctx.artifact('logo-credits.log'), text)
}

/** The game's placement for the American League, or undefined. */
async function placement(
  setup: Sponsored,
  gameId: string
): Promise<
  | { logo_id: string | null; settled_at: Date | null; charged: boolean }
  | undefined
> {
  return await setup.db
    .selectFrom('game_sponsor_logos')
    .select(['logo_id', 'settled_at', 'charged'])
    .where('game_id', '=', gameId)
    .where('league_id', '=', setup.league)
    .executeTakeFirst()
}

async function usedOf(setup: Sponsored, logoId: string): Promise<number> {
  return (
    await setup.db
      .selectFrom('sponsor_logos')
      .select('used')
      .where('id', '=', logoId)
      .executeTakeFirstOrThrow()
  ).used
}

/**
 * Where each drawn logo is against where `logoRect` puts it on the picture
 * it is over: the `contain` box of its video in the element holding both.
 * Read in the page, which has no helpers for `??` or `?.`.
 */
async function logoPlacements(
  web: WebSession,
  placement: LogoPlacement,
  natural: { width: number; height: number },
  tiles: boolean
): Promise<Array<{ drawn: number[]; expected: number[]; background: string }>> {
  return await web.page.evaluate(
    (args: {
      placement: LogoPlacement
      natural: { width: number; height: number }
      tiles: boolean
    }) => {
      const out: Array<{
        drawn: number[]
        expected: number[]
        background: string
      }> = []
      for (const logo of document.querySelectorAll<HTMLElement>(
        '[data-testid="sponsor-logo"]'
      )) {
        let holder = logo.parentElement
        while (holder != null && holder.querySelector('video') == null)
          holder = holder.parentElement
        // The grid's tiles are pictures (`role="img"`); the card behind
        // the grid is not one of them.
        if (
          holder == null ||
          (holder.getAttribute('role') === 'img') !== args.tiles
        )
          continue
        const video = holder.querySelector('video')!
        const box = holder.getBoundingClientRect()
        const aspect =
          video.videoWidth > 0 && video.videoHeight > 0
            ? video.videoWidth / video.videoHeight
            : box.width / box.height
        const fitW = Math.min(box.width, box.height * aspect)
        const fitH = fitW / aspect
        // The card's own picture is its whole surface; a tile's is too.
        const tile = {
          x: box.left + (box.width - fitW) / 2,
          y: box.top + (box.height - fitH) / 2,
          w: fitW,
          h: fitH
        }
        const ratio = args.natural.width / args.natural.height
        const h = Math.min(
          args.placement.maxHeight * tile.h,
          (args.placement.maxWidth * tile.w) / ratio
        )
        const w = h * ratio
        const drawn = logo.getBoundingClientRect()
        out.push({
          drawn: [drawn.left, drawn.top, drawn.width, drawn.height],
          expected: [
            tile.x + tile.w - args.placement.side * tile.w - w,
            tile.y + args.placement.top * tile.h,
            w,
            h
          ],
          background: getComputedStyle(logo).backgroundColor
        })
      }
      return out
    },
    { placement, natural, tiles }
  )
}

/** The Yankees player's session on the web, signed in. */
async function playerOnWeb(
  ctx: E2eContext,
  setup: Sponsored
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

/** Opens the game's card on `videoId`, and waits for its first picture. */
async function openCard(
  ctx: E2eContext,
  web: WebSession,
  gameId: string,
  videoId: string
): Promise<void> {
  await web.m.openLink({
    link: `${ctx.stack.origin}/games/${gameId}?video=${videoId}`
  })
  await eventually(async () => {
    const shown = await web.page.evaluate(() =>
      [...document.querySelectorAll('video')].some(
        video => video.readyState >= 2
      )
    )
    expect(shown, 'the card has a picture').equals(true)
  }, 60_000)
}

/** The game's sponsorship as its player reads it, once it has a logo. */
async function sponsoredRead(
  setup: Sponsored,
  gameId: string
): Promise<GameSponsors> {
  let answer: GameSponsors | undefined
  await eventually(async () => {
    answer = await setup.player.gameSponsors(gameId)
    expect(answer.logo, 'the game has its logo').not.equals(null)
  }, 60_000)
  return answer!
}

/**
 * The game's live videos, once its cameras have published: `beganPublishing`
 * has made them live and given the game its logo.
 */
async function liveVideos(setup: Sponsored, gameId: string): Promise<string[]> {
  let ids: string[] = []
  await eventually(async () => {
    ids = (
      await setup.db
        .selectFrom('videos')
        .select('id')
        .where('game_id', '=', gameId)
        .where('status', '=', 'live')
        .where('hidden', '=', false)
        .orderBy('title')
        .execute()
    ).map(row => row.id)
    expect(ids.length, 'four live cameras').equals(4)
  }, 120_000)
  return ids
}

/**
 * Moves the game's live recordings' start 31 minutes back, so the next
 * minute's settle finds it recorded for more than 30, and waits for the
 * charge.
 */
async function chargeAfterThirty(
  ctx: E2eContext,
  setup: Sponsored,
  gameId: string,
  logoId: string
): Promise<void> {
  await readCredits(ctx, setup, 'live, before 30 minutes', [gameId])
  const held = await placement(setup, gameId)
  expect(held).deep.include({ logo_id: logoId, settled_at: null })
  expect(held?.charged).equals(false)
  expect(await usedOf(setup, logoId)).equals(0)
  const recordedFor = async (interval: string): Promise<void> => {
    await setup.db
      .updateTable('videos')
      .set({ start_at: sql<Date>`now() - ${interval}::interval` })
      .where('game_id', '=', gameId)
      .where('status', '=', 'live')
      .execute()
  }
  // Recorded 28:30 and on for longer than a sweep's minute: every sweep in
  // that time saw it short of 30:00, the last at most 29:40 in.
  await recordedFor('28 minutes 30 seconds')
  await new Promise(resolve => setTimeout(resolve, LOGO_SETTLE_MS + 10_000))
  expect((await placement(setup, gameId))?.charged, 'charged').equals(false)
  expect(await usedOf(setup, logoId)).equals(0)
  await readCredits(ctx, setup, 'swept short of 30:00, not charged', [gameId])
  // Past 30:00: the next sweep charges it once.
  await recordedFor('30 minutes')
  await eventually(async () => {
    expect((await placement(setup, gameId))?.charged, 'charged').equals(true)
  }, SETTLE_MS)
  expect(await usedOf(setup, logoId)).equals(1)
  await readCredits(ctx, setup, 'swept past 30:00, charged once', [gameId])
}

/**
 * E5 on the web: the live game's card, or its four-angle grid, draws the
 * logo on every picture from its first frame, where `logoRect` puts it.
 */
function liveWeb(view: 'single' | 'grid') {
  return async (ctx: E2eContext): Promise<void> => {
    if (ctx.surface !== 'web-chromium')
      throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
    const setup = await world(ctx)
    const handle = stackHandle(ctx)
    const gameId = setup.world.ids.yankeesAtRedSox
    const logoId = await acceptLogo(ctx, setup)
    const cameras = await publishGame(handle, {
      gameId,
      token: setup.admin.token!,
      runDir: join(ctx.runDir, 'live')
    })
    try {
      const videos = await liveVideos(setup, gameId)
      const sponsors = await sponsoredRead(setup, gameId)
      await readCredits(ctx, setup, 'first publish', [gameId])
      const web = await playerOnWeb(ctx, setup)
      await web.m.openLink({
        link:
          view === 'single'
            ? `${ctx.stack.origin}/games/${gameId}?video=${videos[0]}`
            : `${ctx.stack.origin}/games/${gameId}?angles=${videos.join(',')}`
      })
      const wanted = view === 'single' ? 1 : 4
      const placementOf =
        view === 'single'
          ? sponsors.overlay.logo.single
          : sponsors.overlay.logo.grid
      // From the first frame: the logo is there as soon as a picture is.
      await eventually(async () => {
        const firstFrame = await web.page.evaluate(() =>
          [...document.querySelectorAll('video')].some(
            video => video.readyState >= 2
          )
        )
        expect(firstFrame, 'a picture').equals(true)
      }, 60_000)
      const drawn = await logoPlacements(
        web,
        placementOf,
        sponsors.logo!,
        view === 'grid'
      )
      expect(drawn.length, 'a logo on every picture').equals(wanted)
      for (const one of drawn) {
        one.drawn.forEach((value, index) => {
          expect(value).closeTo(one.expected[index], 1)
        })
        // Its own ground is the PNG's, transparent over the video.
        expect(one.background).equals('rgba(0, 0, 0, 0)')
      }
      await ctx.checkpoint(`logo-${view}`, {
        expect: [{ id: 'sponsor-logo' }]
      })
      await web.m
        .takeScreenshot({ path: ctx.artifact(`logo-${view}-web.png`) })
        .catch(() => undefined)
      await chargeAfterThirty(ctx, setup, gameId, logoId)
      // A second playback reads it again and charges nothing.
      await web.m.openLink({
        link: `${ctx.stack.origin}/games/${gameId}?video=${videos[0]}`
      })
      await web.m.assertVisible({ id: 'sponsor-logo', timeout: 60_000 })
      for (let i = 0; i < 5; i++) await setup.player.gameSponsors(gameId)
      await new Promise(resolve => setTimeout(resolve, 70_000))
      expect(await usedOf(setup, logoId)).equals(1)
      await readCredits(ctx, setup, 'a second playback', [gameId])
    } finally {
      for (const camera of cameras) await camera.stop().catch(() => undefined)
      await setup.db.destroy()
    }
  }
}

/** E5 on the iPhone app: the live game's card draws the logo. */
async function livePhone(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'ios-app')
    throw new BlockedError(`runs on ios-app, not ${ctx.surface}`)
  const udid = ctx.device('phone')
  const setup = await world(ctx)
  const handle = stackHandle(ctx)
  const gameId = setup.world.ids.yankeesAtRedSox
  const logoId = await acceptLogo(ctx, setup)
  const cameras = await publishGame(handle, {
    gameId,
    token: setup.admin.token!,
    runDir: join(ctx.runDir, 'live')
  })
  try {
    const videos = await liveVideos(setup, gameId)
    await sponsoredRead(setup, gameId)
    await readCredits(ctx, setup, 'first publish', [gameId])
    const device = await ctx.attach('phone', {
      platform: 'ios',
      appId: APP_ID
    })
    await device.launchApp({ appId: APP_ID, stopApp: true })
    await signInWithPassword(device, setup.world.accounts.yankeesPlayer)
    await openInApp({
      platform: 'ios',
      udid,
      appId: APP_ID,
      link: appLink(`games/${gameId}?video=${videos[0]}`),
      device,
      simulator: true
    })
    await ctx.checkpoint(
      'logo-phone',
      { expect: [{ id: 'sponsor-logo', timeout: 60_000 }] },
      device
    )
    await chargeAfterThirty(ctx, setup, gameId, logoId)
    // The picture once the game has played a while: a capture just after
    // the link opened it could still be the launch screen the simulator
    // shows over a cold start.
    await device.assertVisible({ id: 'sponsor-logo', timeout: 30_000 })
    await run('xcrun', [
      'simctl',
      'io',
      udid,
      'screenshot',
      ctx.artifact('logo-single-ios.png')
    ])
  } finally {
    for (const camera of cameras) await camera.stop().catch(() => undefined)
    await setup.db.destroy()
  }
}

/** One two-minute angle: enough to be a recording, well under 30 minutes. */
const SHORT = [{ title: 'Home Plate', durationSec: 120 }] as const

/** E6: a game begun with the American League's logos used up has none. */
async function noCredits(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await world(ctx)
  try {
    const gameId = setup.world.ids.yankeesAtRedSox
    const logoId = await acceptLogo(ctx, setup)
    // Every game of the league's only logo used.
    await setup.db
      .updateTable('sponsor_logos')
      .set(eb => ({ used: eb.ref('allocation') }))
      .where('id', '=', logoId)
      .execute()
    const recorded = await recordGame(stackHandle(ctx), {
      gameId,
      startAt: new Date((await acceptedAt(setup, logoId)).getTime() + 1000),
      runDir: join(ctx.runDir, 'recording'),
      angles: SHORT
    })
    await readCredits(ctx, setup, 'recorded with no credits', [gameId])
    expect(await placement(setup, gameId)).equals(undefined)
    expect(await setup.player.gameSponsors(gameId)).deep.include({
      leagueId: null,
      logo: null
    })
    const web = await playerOnWeb(ctx, setup)
    await openCard(ctx, web, gameId, recorded['Home Plate'])
    await ctx.checkpoint('no-logo', {
      expect: [{ id: 'sponsor-logo', absent: true }]
    })
  } finally {
    await setup.db.destroy()
  }
}

/**
 * E6: a game recorded before the logo was accepted has none, even for an
 * angle added after; one recorded after has it, keeps it under 30 minutes
 * for nothing, and is settled free once its recording is in.
 */
async function beforeAccept(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await world(ctx)
  const handle = stackHandle(ctx)
  try {
    const before = setup.world.ids.yankeesAtRedSox
    const after = setup.world.ids.dodgersAtYankees
    const earlier = await recordGame(handle, {
      gameId: before,
      startAt: new Date(Date.now() - 24 * 60 * 60_000),
      runDir: join(ctx.runDir, 'before'),
      angles: SHORT
    })
    const logoId = await acceptLogo(ctx, setup)
    const accepted = await acceptedAt(setup, logoId)
    // Another angle of the earlier game, begun now: still the game's start.
    await recordGame(handle, {
      gameId: before,
      startAt: new Date(accepted.getTime() + 1000),
      runDir: join(ctx.runDir, 'before-again'),
      angles: [{ title: 'First Base', durationSec: 120 }]
    })
    const later = await recordGame(handle, {
      gameId: after,
      startAt: new Date(accepted.getTime() + 1000),
      runDir: join(ctx.runDir, 'after'),
      angles: SHORT
    })
    await readCredits(ctx, setup, 'recorded before and after the accept', [
      before,
      after
    ])
    expect(await placement(setup, before)).equals(undefined)
    expect((await setup.player.gameSponsors(before)).logo).equals(null)
    expect((await placement(setup, after))?.logo_id).equals(logoId)
    expect((await setup.player.gameSponsors(after)).logo).not.equals(null)
    expect(await usedOf(setup, logoId)).equals(0)
    await eventually(async () => {
      expect((await placement(setup, after))?.settled_at, 'settled').not.equals(
        null
      )
    }, SETTLE_MS)
    const settled = await placement(setup, after)
    expect(settled?.charged).equals(false)
    expect(settled?.logo_id).equals(logoId)
    expect(await usedOf(setup, logoId)).equals(0)
    await readCredits(ctx, setup, 'the short game settled free', [after])
    const web = await playerOnWeb(ctx, setup)
    await openCard(ctx, web, after, later['Home Plate'])
    await ctx.checkpoint('logo-after-accept', {
      expect: [{ id: 'sponsor-logo', timeout: 60_000 }]
    })
    await openCard(ctx, web, before, earlier['Home Plate'])
    await ctx.checkpoint('no-logo-before-accept', {
      expect: [{ id: 'sponsor-logo', absent: true }]
    })
  } finally {
    await setup.db.destroy()
  }
}

export default defineE2e({
  id: 'playback/sponsors/logo',
  title:
    "A game is given its league's sponsor logo when its first recording begins, every player draws it from the first frame, and it uses a credit only at 30 minutes",
  kind: 'e2e',
  covers: [
    'src/server/sponsors/logos.ts',
    'src/server/routes/sponsors.ts',
    'src/server/live/controller.ts',
    'src/server/media/ingestFile.ts',
    'src/app/player/sponsors/**',
    'src/app/player/PlayerSurface.tsx',
    'src/app/player/MultiCamView.tsx',
    'src/app/player/MultiCamView.native.tsx',
    'src/app/screens/GameScreen.tsx'
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
    'single-web': liveWeb('single'),
    'grid-web': liveWeb('grid'),
    'phone-ios-app': livePhone,
    'no-credits': noCredits,
    'before-accept': beforeAccept
  }
})
