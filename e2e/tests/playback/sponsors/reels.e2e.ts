import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'

import { TeamStationClient } from '../../../../src/common/api'
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
  type PlayerSample,
  readSlots,
  REEL_MS,
  type ReelSetup,
  reelsRead,
  reelWindow,
  reelWorld,
  sampleLines,
  samples,
  scorer,
  startSampling
} from '../../../rigs/media/sponsorReelGame'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * A league's sponsor reels on the game's clock (#220): placed at the
 * official start of a game being recorded live whose sponsored team has nine
 * players and nothing scored, and ten seconds after each half-inning ends,
 * an undo inside the first nine seconds dropping the slot. Every player
 * plays the same reel at the same moment, in its layout's reel space (the
 * card's in the board's place), with the game's sound faded to 20% over a
 * second and back, live and recorded.
 *
 * `reel-slots.log` keeps the `psql` reads of the placements and half ends,
 * and `reel-audio-web.log` the game's volume read every 100 ms.
 */

const DESKTOP = { width: 1280, height: 800 }
const run = promisify(execFile)
const APP_ID = 'app.teamstation.develop'

const log = (ctx: E2eContext, name: string, text: string): void => {
  appendFileSync(ctx.artifact(name), text)
}
const slots = async (
  ctx: E2eContext,
  setup: ReelSetup,
  step: string
): Promise<void> => {
  await readSlots(
    setup,
    `${ctx.scenarioId}: ${step}`,
    ctx.artifact('reel-slots.log'),
    appendFileSync
  )
}

/** The Yankees player's session on the web, signed in. */
async function playerOnWeb(
  ctx: E2eContext,
  setup: ReelSetup,
  size = DESKTOP
): Promise<WebSession> {
  const web = await ctx.browser(size, { h264: true })
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

/** Waits until the page's players have played a whole reel and come back up. */
async function wholeReel(
  web: WebSession,
  withinMs: number
): Promise<{
  list: PlayerSample[]
  window: NonNullable<ReturnType<typeof reelWindow>>
}> {
  let found: ReturnType<typeof reelWindow> = null
  let list: PlayerSample[] = []
  await eventually(async () => {
    list = await samples(web)
    found = reelWindow(list)
    expect(found, 'a reel played out and the game came back up').not.equals(
      null
    )
  }, withinMs)
  return { list, window: found! }
}

/** The fades and the reel's length, as the samples have them. */
function expectFades(
  window: NonNullable<ReturnType<typeof reelWindow>>,
  list: PlayerSample[]
): void {
  // Down over the second before the reel, not all at once.
  expect(window.low - window.down, 'the fade down').within(600, 1600)
  expect(window.gone - window.shown, 'the reel’s length').within(
    REEL_MS - 1500,
    REEL_MS + 1500
  )
  // Held at 0.2 through it.
  for (const one of list.filter(
    sample => sample.reel != null && sample.at > window.shown + 300
  ))
    expect(one.volume, 'quiet under the reel').at.most(0.21)
  // Back to full within the second after.
  expect(window.up - window.gone, 'the fade up').at.most(1600)
}

/** E7: the pre-game reel on the live card, at the official start. */
async function pregameLive(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  const reelId = await acceptReel(ctx, setup)
  const web = await playerOnWeb(ctx, setup)
  const { startAt, cameras, videos } = await goLive(ctx, setup, 20_000)
  try {
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?video=${videos[0]}`
    })
    await startSampling(web)
    const read = await reelsRead(setup, 1, 120_000)
    const pregame = read.reels[0]
    expect(pregame.reelId).equals(reelId)
    // At the official start, or a second after a stream that began late.
    expect(pregame.startMs).at.least(startAt.getTime())
    expect(pregame.startMs).at.most(startAt.getTime() + 5 * 60_000)
    await slots(ctx, setup, 'pre-game placed')
    const { list, window } = await wholeReel(web, 120_000)
    expectFades(window, list)
    expect(
      list.filter(one => one.reel != null).some(one => one.board),
      'no board over the reel'
    ).equals(false)
    log(
      ctx,
      'reel-audio-web.log',
      `\n## ${ctx.scenarioId}: the live card, the pre-game reel\n` +
        `$ node readVolume.mjs (video.volume every 100 ms through the page)\n${sampleLines(list, window.down - 2000)}\n`
    )
  } finally {
    await endLive(setup, cameras).catch(() => undefined)
    await setup.db.destroy()
  }
}

/** The game's placements of one half, from the database. */
async function placedFor(
  setup: ReelSetup,
  inning: number,
  half: 'top' | 'bottom'
): Promise<Array<{ starts_at: Date; placed_at: Date }>> {
  return await setup.db
    .selectFrom('game_reel_placements')
    .select(['starts_at', 'placed_at'])
    .where('game_id', '=', setup.gameId)
    .where('slot', '=', 'half')
    .where('inning', '=', inning)
    .where('half', '=', half)
    .execute()
}

/** Where the game's recordings start, by id. */
async function startsOf(setup: ReelSetup): Promise<Map<string, number>> {
  const rows = await setup.db
    .selectFrom('videos')
    .select(['id', 'start_at'])
    .where('game_id', '=', setup.gameId)
    .where('hidden', '=', false)
    .execute()
  return new Map(
    rows.map(row => [row.id, new Date(row.start_at ?? 0).getTime()])
  )
}

/**
 * E8: a half-inning's reel ten seconds after its end, on every angle live;
 * with the scoreboard overlay off, still on the card within a second of its
 * placement; then in the recorded game at the same moment, from the offset
 * when sought into, gone when sought out, paused with the game.
 */
async function halfInning(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  await acceptReel(ctx, setup)
  const web = await playerOnWeb(ctx, setup)
  // The official start an hour away: no pre-game reel.
  const { cameras, videos } = await goLive(ctx, setup, 60 * 60_000)
  const score = await scorer(setup)
  let cleared = false
  try {
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?angles=${videos.join(',')}`
    })
    await eventually(async () => {
      const pictures = await web.page.evaluate(
        () =>
          [...document.querySelectorAll('video')].filter(
            video => video.readyState >= 2
          ).length
      )
      expect(pictures, 'four live pictures').at.least(4)
    }, 90_000)
    await startSampling(web)
    const ended = await score.endHalf()
    const read = await reelsRead(setup, 1, 30_000)
    const reel = read.reels[0]
    // Ten seconds after the post that ended the half.
    expect(reel.startMs - ended).within(8_500, 11_500)
    await slots(ctx, setup, 'top of the 1st ended, reel placed')
    const { list, window } = await wholeReel(web, 120_000)
    expectFades(window, list)
    await web.m
      .takeScreenshot({ path: ctx.artifact('reel-half-inning-live-web.png') })
      .catch(() => undefined)
    log(
      ctx,
      'reel-audio-web.log',
      `\n## ${ctx.scenarioId}: the live grid of four, the top of the 1st\n` +
        `$ node readVolume.mjs (video.volume every 100 ms through the page)\n${sampleLines(list, window.down - 2000)}\n`
    )

    // The overlay off on the node: the card still hears of the next reel.
    await setup.db
      .insertInto('system_settings')
      .values({
        key: 'scoreboard.overlayStartDate',
        value: JSON.stringify('2999-01-01'),
        updated_by: null
      })
      .onConflict(oc =>
        oc.column('key').doUpdateSet({ value: JSON.stringify('2999-01-01') })
      )
      .execute()
    cleared = true
    // The servers keep their settings for 30 seconds.
    await new Promise(resolve => setTimeout(resolve, 32_000))
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?video=${videos[0]}`
    })
    await web.m.assertVisible({ id: 'gameVideoZones', timeout: 60_000 })
    expect((await setup.player.gameSponsors(setup.gameId)).reels).length(1)
    await score.endHalf()
    let placedAt = 0
    await eventually(async () => {
      const rows = await placedFor(setup, 1, 'bottom')
      expect(rows, 'the bottom of the 1st placed').length(1)
      placedAt = new Date(rows[0].placed_at).getTime()
    }, 30_000)
    await new Promise(resolve => setTimeout(resolve, 3_000))
    const asked = await web.page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter(entry => /\/games\/[^/]+\/sponsors/.test(entry.name))
        .map(entry => performance.timeOrigin + entry.startTime)
    )
    const after = asked.filter(at => at >= placedAt - 50)
    expect(after.length, 'a read after the placement').greaterThan(0)
    expect(Math.min(...after) - placedAt, 'read within a second').at.most(1000)
    await slots(ctx, setup, 'overlay off, bottom of the 1st placed')
  } finally {
    if (cleared)
      await setup.db
        .deleteFrom('system_settings')
        .where('key', '=', 'scoreboard.overlayStartDate')
        .execute()
        .catch(() => undefined)
    await endLive(setup, cameras).catch(() => undefined)
  }

  // The recorded game: the same reel at the same moment.
  try {
    const read = await setup.player.gameSponsors(setup.gameId)
    const reel = read.reels[0]
    const starts = await startsOf(setup)
    const first = videos[0]
    const offsetOf = (wallMs: number): number =>
      (wallMs - starts.get(first)!) / 1000
    // The reel as a viewer sees it: the grid from 15 s before it through its
    // end and the board's return, as maestro-d screenshots taken as fast as
    // it can (a web device records no screen) made into a video at the rate
    // they came (best effort: the run goes on without it).
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?angles=${videos.join(',')}&t=${offsetOf(reel.startMs - 15_000).toFixed(1)}`
    })
    try {
      const frames = ctx.artifact('reel-frames')
      mkdirSync(frames, { recursive: true })
      const began = Date.now()
      let count = 0
      while (Date.now() - began < 40_000)
        await web.m.takeScreenshot({
          path: join(frames, `f-${String(count++).padStart(4, '0')}.png`)
        })
      const fps = count / ((Date.now() - began) / 1000)
      await run(process.env.TS_FFMPEG ?? 'ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-framerate',
        fps.toFixed(3),
        '-i',
        join(frames, 'f-%04d.png'),
        '-vf',
        'scale=1280:-2,format=yuv420p',
        '-c:v',
        'libx264',
        '-r',
        '30',
        ctx.artifact('reel-half-inning-web.mp4')
      ])
    } catch (error) {
      log(ctx, 'reel-recording.txt', `no recording: ${String(error)}\n`)
    }
    // Sought into its middle: at the offset, the game at 0.2.
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?angles=${videos.join(',')}&t=${offsetOf(reel.startMs + 5000).toFixed(1)}`
    })
    await startSampling(web)
    let inside: PlayerSample[] = []
    await eventually(async () => {
      inside = (await samples(web)).filter(one => one.reel != null)
      expect(inside.length, 'the reel, sought into').at.least(10)
    }, 60_000)
    // Mid-reel from its first frame drawn, not from its start, and on with
    // the game from there.
    const firstSeen = inside[0]
    expect(firstSeen.reelTime ?? 0, 'from the offset').within(1, REEL_MS / 1000)
    expect(inside.at(-1)!.reelTime ?? 0).greaterThan(firstSeen.reelTime ?? 0)
    expect(inside.at(-1)!.volume, 'quiet').at.most(0.21)
    expect(
      inside.every(one => one.reelMuted === one.muted),
      'the reel muted as the game is'
    ).equals(true)
    // Paused with the game.
    await web.m.pressKey({ key: 'Space' })
    await new Promise(resolve => setTimeout(resolve, 1500))
    const paused = (await samples(web)).at(-1)!
    if (paused.reel != null)
      expect(paused.reelPaused, 'paused with the game').equals(true)
    await web.m.pressKey({ key: 'Space' })
    // Sought out: gone, and the game back up within a second.
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?angles=${videos.join(',')}&t=${offsetOf(reel.startMs + REEL_MS + 20_000).toFixed(1)}`
    })
    await startSampling(web)
    await new Promise(resolve => setTimeout(resolve, 4000))
    const outside = await samples(web)
    expect(
      outside.some(one => one.reel != null),
      'no reel'
    ).equals(false)
    expect(outside.at(-1)!.volume).equals(1)
    log(
      ctx,
      'reel-audio-web.log',
      `\n## ${ctx.scenarioId}: the recorded grid, sought into the reel, paused, and sought out\n${sampleLines(inside, inside[0].at)}\n${sampleLines(outside, inside[0].at)}\n`
    )
  } finally {
    await setup.db.destroy()
  }
}

/** E8: an undo posted 5 s after an end places nothing and uses no credit. */
async function undoInsideWindow(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  const reelId = await acceptReel(ctx, setup)
  const { cameras } = await goLive(ctx, setup, 60 * 60_000)
  try {
    const score = await scorer(setup)
    const ended = await score.endHalf()
    await eventually(async () => {
      const ends = await setup.db
        .selectFrom('game_half_ends')
        .select('state')
        .where('game_id', '=', setup.gameId)
        .execute()
      expect(ends.map(row => row.state)).deep.equals(['waiting'])
    }, 5_000)
    await slots(ctx, setup, 'top of the 1st ended, waiting')
    await new Promise(resolve =>
      setTimeout(resolve, Math.max(0, ended + 5_000 - Date.now()))
    )
    await score.undoBatter()
    await new Promise(resolve => setTimeout(resolve, 15_000))
    expect(await placedFor(setup, 1, 'top')).deep.equals([])
    const reel = await setup.db
      .selectFrom('sponsor_reels')
      .select('used')
      .where('id', '=', reelId)
      .executeTakeFirstOrThrow()
    expect(reel.used, 'no credit used').equals(0)
    expect((await setup.player.gameSponsors(setup.gameId)).reels).deep.equals(
      []
    )
    await slots(ctx, setup, 'undone at 5 s: nothing placed')
  } finally {
    await endLive(setup, cameras).catch(() => undefined)
    await setup.db.destroy()
  }
}

/**
 * E7, two tracks (intake answer 4): the interleague Dodgers @ Yankees going
 * live at its official start gets a pre-game reel from each team's league at
 * the same moment, one credit of each, and each team's player reads their
 * own league's track.
 */
async function twoTracks(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const al = await reelWorld(ctx)
  const handle = stackHandle(ctx)
  const client = async (
    account: keyof typeof al.world.accounts
  ): Promise<TeamStationClient> =>
    new TeamStationClient({
      baseUrl: handle.api,
      token: await apiToken(handle.api, al.world.accounts[account])
    })
  const gameId = al.world.ids.dodgersAtYankees
  const nl: ReelSetup = {
    ...al,
    league: al.world.ids.nationalLeague,
    admin: await client('nlAdmin'),
    player: await client('dodgersPlayer'),
    gameId
  }
  const game: ReelSetup = { ...al, gameId }
  const reels = {
    [al.league]: await acceptReel(ctx, al),
    [nl.league]: await acceptReel(ctx, nl)
  }
  const { startAt, cameras } = await goLive(ctx, game, 20_000)
  try {
    let placed: Array<{
      league_id: string
      reel_id: string | null
      starts_at: Date
    }> = []
    await eventually(async () => {
      placed = await game.db
        .selectFrom('game_reel_placements')
        .select(['league_id', 'reel_id', 'starts_at'])
        .where('game_id', '=', gameId)
        .where('slot', '=', 'pregame')
        .orderBy('league_id')
        .execute()
      expect(placed, 'a pre-game reel from each league').length(2)
    }, 120_000)
    const tracks = Object.fromEntries(
      placed.map(row => [row.league_id, row.reel_id])
    )
    expect(tracks).deep.equals(reels)
    // The same moment for both: the official start, or just after a late
    // stream.
    expect(placed[0].starts_at.getTime()).equals(placed[1].starts_at.getTime())
    expect(placed[0].starts_at.getTime()).at.least(startAt.getTime())
    for (const setup of [game, nl])
      await readSlots(
        setup,
        `${ctx.scenarioId}: Dodgers @ Yankees live, ${setup.league === nl.league ? 'National' : 'American'} League`,
        ctx.artifact('reel-slots.log'),
        appendFileSync
      )
    for (const setup of [al, nl]) {
      const read = await setup.player.gameSponsors(gameId)
      expect(read.leagueId, 'the player’s own league').equals(setup.league)
      expect(read.reels.map(reel => reel.reelId)).deep.equals([
        reels[setup.league]
      ])
    }
    for (const reelId of Object.values(reels)) {
      const reel = await game.db
        .selectFrom('sponsor_reels')
        .select('used')
        .where('id', '=', reelId)
        .executeTakeFirstOrThrow()
      expect(reel.used, 'one credit of each league').equals(1)
    }
  } finally {
    await endLive(game, cameras).catch(() => undefined)
    await al.db.destroy()
  }
}

/**
 * E8a: in iPhone Safari, where a `<video>`'s volume cannot be set, the game
 * is muted for the reel and given back its sound after; a viewer who muted
 * it keeps it muted.
 */
async function audioSafari(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-safari-ios')
    throw new BlockedError(`runs on web-safari-ios, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  await acceptReel(ctx, setup)
  const { cameras, videos } = await goLive(ctx, setup, 60 * 60_000)
  try {
    const score = await scorer(setup)
    await score.endHalf()
    const read = await reelsRead(setup, 1, 30_000)
    await new Promise(resolve => setTimeout(resolve, 30_000))
    await endLive(setup, cameras)
    const reel = read.reels[0]
    const starts = await startsOf(setup)
    const web = await playerOnWeb(ctx, setup, { width: 390, height: 844 })
    const offset = (reel.startMs - 3000 - starts.get(videos[0])!) / 1000
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?video=${videos[0]}&t=${offset.toFixed(1)}`
    })
    // The card's sound on: its top-left square.
    await web.m.tapOn({ id: 'gameVideoZones', timeout: 60_000 })
    await startSampling(web)
    const { list } = await wholeReel(web, 60_000)
    const during = list.filter(one => one.reel != null)
    expect(
      list.every(one => one.volume === 1),
      'the volume never moves'
    ).equals(true)
    expect(
      during.slice(2).every(one => one.muted),
      'muted for the reel'
    ).equals(true)
    expect(list.at(-1)!.muted, 'heard again after it').equals(false)
    log(
      ctx,
      'reel-audio-web.log',
      `\n## ${ctx.scenarioId}: iPhone Safari, the recorded card\n${sampleLines(list, list[0].at)}\n`
    )
  } finally {
    await setup.db.destroy()
  }
}

/** A recorded reel game: live with a half-inning's reel, then finished. */
async function recordedReelGame(
  ctx: E2eContext,
  setup: ReelSetup
): Promise<{
  videos: string[]
  reel: { startMs: number }
  offsetOf: (videoId: string, wallMs: number) => number
}> {
  await acceptReel(ctx, setup)
  const { cameras, videos } = await goLive(ctx, setup, 60 * 60_000)
  let reel: { startMs: number }
  try {
    // Recorded for half a minute before the half ends, and after the reel.
    await new Promise(resolve => setTimeout(resolve, 30_000))
    const score = await scorer(setup)
    await score.endHalf()
    reel = (await reelsRead(setup, 1, 30_000)).reels[0]
    await new Promise(resolve =>
      setTimeout(
        resolve,
        Math.max(0, reel.startMs + REEL_MS + 20_000 - Date.now())
      )
    )
  } finally {
    await endLive(setup, cameras)
  }
  const starts = await startsOf(setup)
  return {
    videos,
    reel: reel!,
    offsetOf: (videoId, wallMs) => (wallMs - starts.get(videoId)!) / 1000
  }
}

/** The reel's rect and the board's, and the tiles', in the page. */
async function placed(web: WebSession): Promise<{
  reel: number[] | null
  board: boolean
  tiles: number[][]
}> {
  return await web.page.evaluate(() => {
    const holder = document.querySelector<HTMLElement>(
      '[data-testid="sponsor-reel"]'
    )
    const rect = (element: Element): number[] => {
      const box = element.getBoundingClientRect()
      return [box.left, box.top, box.width, box.height]
    }
    return {
      reel: holder == null ? null : rect(holder),
      board:
        document.querySelector('[data-testid="scoreboard-overlay"]') != null,
      tiles: [...document.querySelectorAll('[role="img"]')]
        .filter(tile => tile.querySelector('video') != null)
        .map(rect)
    }
  })
}

/**
 * E9 on the web: the recorded reel game sought into its half-inning reel
 * in each layout sideways and on the card: the reel in the layout's space,
 * 16:9 and at most a third of the screen, the board hidden only where the
 * reel takes its place.
 */
async function layoutsWeb(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  try {
    const game = await recordedReelGame(ctx, setup)
    const web = await playerOnWeb(ctx, setup)
    const at = (videoId: string): string =>
      game.offsetOf(videoId, game.reel.startMs + 2000).toFixed(1)
    const report: string[] = []
    const views: Array<{ name: string; link: string; count: number }> = [
      {
        name: 'card',
        link: `/games/${setup.gameId}?video=${game.videos[0]}&t=${at(game.videos[0])}`,
        count: 0
      },
      ...[1, 2, 3, 4].map(count => ({
        name: `landscape${count}`,
        link: `/games/${setup.gameId}?angles=${game.videos.slice(0, count).join(',')}&t=${at(game.videos[0])}`,
        count
      }))
    ]
    for (const view of views) {
      await web.m.openLink({ link: `${ctx.stack.origin}${view.link}` })
      let shown: Awaited<ReturnType<typeof placed>> | undefined
      await eventually(async () => {
        shown = await placed(web)
        expect(shown.reel, `the reel in ${view.name}`).not.equals(null)
      }, 60_000)
      const [x, y, w, h] = shown!.reel!
      expect(w / h, 'the reel’s shape').closeTo(16 / 9, 0.02)
      expect(w, 'at most a third of the width').at.most(DESKTOP.width / 3 + 1)
      const tiles = shown!.tiles
      if (view.count === 2) {
        // Under the right-hand angle, the board and the box still shown.
        const right = tiles.reduce((a, b) => (b[0] > a[0] ? b : a))
        expect(y).at.least(right[1] + right[3] - 1)
        expect(x).at.least(right[0] - 1)
        expect(shown!.board, 'the board stays').equals(true)
      } else if (view.count === 3) {
        expect(x + w).at.most(DESKTOP.width / 2 + 1)
        expect(y + h).at.most(DESKTOP.height / 2 + 1)
        expect(shown!.board, 'the board hidden').equals(false)
      } else if (view.count === 4) {
        const corner = tiles.reduce((a, b) =>
          b[0] + b[1] < a[0] + a[1] ? b : a
        )
        expect(x).at.least(corner[0] - 1)
        expect(y).at.least(corner[1] - 1)
        expect(x + w).at.most(corner[0] + corner[2] + 1)
        expect(shown!.board, 'the board hidden').equals(false)
      } else {
        expect(shown!.board, 'the board hidden').equals(false)
      }
      report.push(
        `${view.name}: reel ${[x, y, w, h].map(n => n.toFixed(1)).join(' ')} board ${String(shown!.board)}`
      )
      await web.m.takeScreenshot({
        path: ctx.artifact(`reel-${view.name}-web-after.png`)
      })
    }
    // The card's board is back after the reel.
    await web.m.openLink({
      link: `${ctx.stack.origin}/games/${setup.gameId}?video=${game.videos[0]}&t=${game.offsetOf(game.videos[0], game.reel.startMs + REEL_MS + 3000).toFixed(1)}`
    })
    await web.m.assertVisible({ id: 'scoreboard-overlay', timeout: 60_000 })
    expect((await placed(web)).reel).equals(null)
    writeFileSync(
      ctx.artifact('reel-layouts-web.txt'),
      `${report.join('\n')}\n`
    )
  } finally {
    await setup.db.destroy()
  }
}

/**
 * E9 on the phones: the recorded reel game sought into its reel on the
 * app, upright with one to four angles on the iPhone, and sideways with
 * four on Android: the reel drawn, a screenshot of each.
 */
function layoutsApp(platform: 'ios' | 'android') {
  return async (ctx: E2eContext): Promise<void> => {
    const surface = platform === 'ios' ? 'ios-app' : 'android-app'
    if (ctx.surface !== surface)
      throw new BlockedError(`runs on ${surface}, not ${ctx.surface}`)
    const udid = ctx.device('phone')
    const setup = await reelWorld(ctx)
    try {
      const game = await recordedReelGame(ctx, setup)
      const device = await ctx.attach('phone', { platform, appId: APP_ID })
      await device.launchApp({ appId: APP_ID, stopApp: true })
      await signInWithPassword(device, setup.world.accounts.yankeesPlayer)
      const counts = platform === 'ios' ? [1, 2, 3, 4] : [4]
      for (const count of counts) {
        await openInApp({
          platform,
          udid,
          appId: APP_ID,
          link: appLink(
            `games/${setup.gameId}?angles=${game.videos.slice(0, count).join(',')}&t=${game.offsetOf(game.videos[0], game.reel.startMs + 1000).toFixed(1)}`
          ),
          device,
          simulator: true
        })
        if (platform === 'android')
          await device.setOrientation({ orientation: 'LANDSCAPE_LEFT' })
        await ctx.checkpoint(
          `reel-${count}`,
          { expect: [{ id: 'sponsor-reel', timeout: 60_000 }] },
          device
        )
        // The pictures up and playing under it before the shot.
        await new Promise(resolve => setTimeout(resolve, 5000))
        await device.takeScreenshot({
          path: ctx.artifact(
            platform === 'ios'
              ? `reel-portrait${count}-ios-after.png`
              : `reel-landscape${count}-android-after.png`
          )
        })
      }
    } finally {
      await setup.db.destroy()
    }
  }
}

export default defineE2e({
  id: 'playback/sponsors/reels',
  title:
    "A league's sponsor reels are placed before games and after half-innings, and every player plays them in its layout's reel space with the game at 20%",
  kind: 'e2e',
  covers: [
    'src/server/sponsors/reels.ts',
    'src/server/sponsors/sweeps.ts',
    'src/common/sponsors/halves.ts',
    'src/app/player/sponsors/**',
    'src/app/player/multiCam/playerLayout.ts',
    'src/app/player/PlayerSurface.tsx',
    'src/app/player/MultiCamView.tsx',
    'src/app/player/MultiCamView.native.tsx'
  ],
  stack: 'isolated',
  fixtures: ['sponsors'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
    'web-safari-ios': {
      devices: [{ role: 'browser', needs: ['ios-phone'], hardware: 'none' }]
    },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    },
    'android-app': {
      devices: [{ role: 'phone', needs: ['android-phone'], hardware: 'none' }]
    }
  },
  services: ['web'],
  // The phones run a local build of this branch (Devices, in the plan).
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 10,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    'pregame-live': pregameLive,
    'two-tracks': twoTracks,
    'half-inning': halfInning,
    'undo-inside-window': undoInsideWindow,
    'audio-safari-ios': audioSafari,
    'layouts-web': layoutsWeb,
    'layouts-ios-app': layoutsApp('ios'),
    'layouts-android-app': layoutsApp('android')
  }
})
