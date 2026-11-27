import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'

import { TeamStationClient } from '../../../../src/common/api'
import { makeDatabase } from '../../../../src/server/db/database'
import type { FixtureManifest } from '../../../../src/server/dev/fixtures/accounts'
import type { CheckpointSpec, ExpectItem } from '../../../core/checkpoint'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { signInWithPassword } from '../../../core/fixtures'
import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { appLink, openInApp } from '../../../rigs/app/setServer'
import { apiToken } from '../../../rigs/media/recordingSeek'
import { recordGame } from '../../../rigs/media/sponsorRecordings'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * A league administrator sets up Sponsor features (#220) on the real API:
 * logos and reels with their credits, shrunk in the page (or on the phone)
 * before upload and checked by the server, and sponsored Schedule rows with
 * their 10 slots. The `sponsors` world's American League gets a 40-minute
 * "Home Plate" recording first, so the previews play its 30:00–32:00 window.
 * The web scenarios run on Chrome (`h264`), which plays and encodes H.264;
 * the app scenarios need a branch build on the leased phone, pointed at the
 * stack (`e2e/rigs/app/setServer.ts`).
 */

const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 375, height: 812 }
const APP_ID = 'app.teamstation.develop'

const run = promisify(execFile)
const ffmpeg = (): string => process.env.TS_FFMPEG ?? 'ffmpeg'
const ffprobe = (): string => process.env.TS_FFPROBE ?? 'ffprobe'

const ADD_INPUT = '[data-testid="sponsor-drop-zone-input"]'
const LOGO_PREVIEW = 'sponsor-logo-preview'
const REEL_PREVIEW = 'sponsor-reel-preview'
const NO_WEBCODECS =
  "This browser can't shrink videos. Upload reels from the TeamStation mobile app."

const logosLeft = (left: number): ExpectItem => ({
  text: `Remaining game logo credits: ${left} of 300`
})
const reelsLeft = (left: string): ExpectItem => ({
  text: `Remaining reel broadcast credits: ${left} of 1,000`
})
const slotsLeft = (left: number): ExpectItem => ({
  text: `${left} of 10 event stream slots left`
})

/** A still picture made with ffmpeg at `path`. */
async function picture(
  path: string,
  width: number,
  height: number,
  color: string
): Promise<string> {
  await run(ffmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${width}x${height}`,
    '-frames:v',
    '1',
    path
  ])
  return path
}

/** A `seconds`-long H.264 test pattern of `width` × `height` at `fps`, with a tone. */
async function clip(
  path: string,
  seconds: number,
  width: number,
  height: number,
  fps = 30
): Promise<string> {
  await run(
    ffmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      path
    ],
    { maxBuffer: 1 << 24 }
  )
  return path
}

/** What ffprobe says of a video's stream: codec, size, frame rate. */
async function probe(path: string): Promise<{
  codec: string
  width: number
  height: number
  fps: number
}> {
  const { stdout } = await run(ffprobe(), [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height,avg_frame_rate',
    '-of',
    'json',
    path
  ])
  const stream = (
    JSON.parse(stdout) as {
      streams: Array<{
        codec_name: string
        width: number
        height: number
        avg_frame_rate: string
      }>
    }
  ).streams[0]
  const [num, den] = stream.avg_frame_rate.split('/').map(Number)
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    fps: den > 0 ? num / den : num
  }
}

/** A PNG's size, from its header. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1'), 'a PNG').equals('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

interface League {
  world: FixtureManifest
  league: string
  api: TeamStationClient
}

/**
 * Seeds the `sponsors` world and records its Yankees @ Red Sox game, so the
 * American League has the "Home Plate" recording its previews play. The AL
 * admin's client reads back what the screens stored.
 */
async function league(ctx: E2eContext): Promise<League> {
  const handle = stackHandle(ctx)
  const world = await ctx.fixture('sponsors')
  await recordGame(handle, {
    gameId: world.ids.yankeesAtRedSox,
    startAt: new Date(Date.now() - 60 * 60_000),
    runDir: join(ctx.runDir, 'recording')
  })
  const token = await apiToken(handle.api, world.accounts.alAdmin)
  const api = new TeamStationClient({ baseUrl: handle.api, token })
  return { world, league: world.ids.americanLeague, api }
}

/**
 * The password form, on a window of any width. `ctx.signIn` waits for the
 * header's TeamStation menu, which a desktop window draws as its sidebar
 * instead, so this waits for the form to go.
 */
async function signInAsAdmin(
  web: WebSession,
  account: { email: string; password: string }
): Promise<void> {
  const { m } = web
  await m.assertVisible({ text: 'Use a password instead', timeout: 30_000 })
  await m.tapOn({ text: 'Use a password instead' })
  await m.tapOn({ css: 'input[aria-label="E-mail address"]', timeout: 15_000 })
  await m.inputText({ text: account.email })
  await m.tapOn({ css: 'input[aria-label="Password"]', timeout: 15_000 })
  await m.inputText({ text: account.password })
  await m.pressKey({ key: 'Enter' })
  await eventually(async () => {
    const signedIn = await web.page.evaluate(
      () => document.querySelector('input[aria-label="Password"]') == null
    )
    expect(signedIn, 'the password form has gone').equals(true)
  }, 30_000)
}

/** Taps the element at `css` once it is in the middle of the window. */
async function tapCss(web: WebSession, css: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = document.querySelector(${JSON.stringify(css)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ css, timeout: 15_000 })
}

/** Taps the button reading `label`, once it is in the middle of the window. */
async function tapButton(web: WebSession, label: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = [...document.querySelectorAll('[role="button"]')]
        .find(node => node.textContent === ${JSON.stringify(label)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ text: label, role: 'button', timeout: 15_000 })
}

/** The value of the field at `css`, read from the page. */
async function valueOf(web: WebSession, css: string): Promise<string> {
  // No optional chaining or `??` here: the page has no helpers for them.
  return await web.page.evaluate((selector: string) => {
    const field = document.querySelector<HTMLInputElement>(selector)
    return field == null ? '' : field.value
  }, css)
}

/**
 * Types `value` into the empty field at `css`, ten characters at a time: a
 * burst of keys into a growing multi-line field can outrun its renders. A
 * field that still differs is cleared and typed again.
 */
async function typeIntoEmpty(
  web: WebSession,
  css: string,
  value: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await tapCss(web, css)
    const before = await valueOf(web, css)
    if (before !== '') await web.m.eraseText({ characters: before.length + 5 })
    for (let at = 0; at < value.length; at += 10)
      await web.m.inputText({ text: value.slice(at, at + 10) })
    if ((await valueOf(web, css)) === value) return
  }
  expect(await valueOf(web, css), css).equals(value)
}

/**
 * Types a date and time into the row's `datetime-local` field from its
 * month: `MMDDYYYYhhmm` and A or P, as Chrome's segments take them.
 */
async function typeDateTime(web: WebSession, keys: string): Promise<void> {
  const css = 'input[aria-label="Date and time"]'
  await tapCss(web, css)
  // Back to the month segment, whichever segment the tap landed in.
  for (let step = 0; step < 6; step++) await web.m.pressKey({ key: 'Left' })
  // The year takes up to six digits, so Right moves on to the hour.
  await web.m.inputText({ text: keys.slice(0, 8) })
  await web.m.pressKey({ key: 'Right' })
  await web.m.inputText({ text: keys.slice(8) })
}

/** Clears the field at `css` and types `value` into it. */
async function typeInto(
  web: WebSession,
  css: string,
  value: string
): Promise<void> {
  await tapCss(web, css)
  await web.m.eraseText({ characters: 30 }).catch(() => undefined)
  await web.m.inputText({ text: value })
}

/**
 * Signs the AL admin in and walks League Settings → Sponsor features →
 * `screen`, as an administrator does.
 */
async function openThroughSettings(
  ctx: E2eContext,
  size: { width: number; height: number },
  setup: League,
  screen:
    'Sponsor video logos' | 'Sponsor video reels' | 'Sponsor in event stream',
  emulation: { beforeLoad?: string } = {}
): Promise<WebSession> {
  const web = await ctx.browser(size, { h264: true, ...emulation })
  await web.m.openLink({ link: ctx.stack.origin })
  await signInAsAdmin(web, setup.world.accounts.alAdmin)
  await web.m.openLink({
    link: `${ctx.stack.origin}/groups/league/${encodeURIComponent(setup.league)}/settings`
  })
  await tapCss(web, '[data-testid="sponsor-features-row"]')
  await web.m.assertVisible({ text: 'Sponsor Features', timeout: 30_000 })
  await web.m.tapOn({ text: screen, timeout: 15_000 })
  return web
}

/** `ctx.checkpoint`, with the screen it checked kept as `<id>.png`. */
async function checkpoint(
  ctx: E2eContext,
  web: WebSession,
  id: string,
  spec: CheckpointSpec
): Promise<void> {
  await ctx.checkpoint(id, spec)
  await web.m
    .takeScreenshot({ path: ctx.artifact(`${id}.png`) })
    .catch(() => undefined)
}

/** The sample video's playhead, or null before it has one. */
async function sampleTime(web: WebSession): Promise<number | null> {
  return await web.page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(
      'video[aria-label="Sample game video"]'
    )
    return video == null || video.readyState < 2 ? null : video.currentTime
  })
}

/** Waits for the sample to play inside 30:00–32:00, and answers its time. */
async function sampleInWindow(web: WebSession): Promise<number> {
  let at = NaN
  await eventually(async () => {
    const time = await sampleTime(web)
    expect(time, 'the sample plays').not.equals(null)
    expect(time).within(1800, 1920)
    at = time!
  }, 60_000)
  return at
}

/** How many credit rows the table lists. */
async function rowCount(web: WebSession): Promise<number> {
  return await web.page.evaluate(
    () => document.querySelectorAll('[data-testid^="sponsor-row-"]').length
  )
}

/** The whole logos flow (E1), on a window of `size`. */
async function logosFlow(
  ctx: E2eContext,
  size: { width: number; height: number }
): Promise<void> {
  const setup = await league(ctx)
  const big = await picture(ctx.artifact('logo-960x540.png'), 960, 540, 'blue')
  const second = await picture(ctx.artifact('logo-second.png'), 300, 100, 'red')
  const jpeg = await picture(ctx.artifact('logo.jpg'), 300, 200, 'green')
  const web = await openThroughSettings(ctx, size, setup, 'Sponsor video logos')

  await checkpoint(ctx, web, 'logos-empty', {
    expect: [
      { text: 'No logos yet. Add one above.', timeout: 30_000 },
      logosLeft(300)
    ]
  })
  const first = await sampleInWindow(web)

  await web.m.uploadFile({ css: ADD_INPUT, path: jpeg, timeout: 15_000 })
  await checkpoint(ctx, web, 'logos-jpeg-refused', {
    expect: [
      { text: 'Logos must be PNG files.' },
      { id: LOGO_PREVIEW, absent: true }
    ]
  })

  await web.m.uploadFile({ css: ADD_INPUT, path: big, timeout: 15_000 })
  await checkpoint(ctx, web, 'logos-pending', {
    expect: [
      { id: LOGO_PREVIEW, timeout: 15_000 },
      { text: 'Credits for this logo' },
      { text: 'Up to 300 game logo credits left' }
    ]
  })
  await typeInto(web, 'input[aria-label="Credits for this logo"]', '50')
  await tapButton(web, 'Accept')
  await checkpoint(ctx, web, 'logos-accepted', {
    expect: [
      logosLeft(250),
      { text: 'logo-960x540' },
      { id: LOGO_PREVIEW, absent: true }
    ],
    readBack: async () => {
      expect(await rowCount(web)).equals(1)
      const state = await setup.api.sponsorState(setup.league)
      expect(state.logos).has.length(1)
      expect(state.logos[0]).deep.include({ allocation: 50, used: 0 })
      // The page shrank it: the server stored 480 × 270.
      const stored = Buffer.from(
        await (await fetch(state.logos[0].imageUrl)).arrayBuffer()
      )
      expect(pngSize(stored)).deep.equals({ width: 480, height: 270 })
    }
  })
  await web.m
    .takeScreenshot({ path: ctx.artifact('sponsor-logos-web.png') })
    .catch(() => undefined)

  // Cancel on a second pick adds nothing.
  await web.m.uploadFile({ css: ADD_INPUT, path: second, timeout: 15_000 })
  await web.m.assertVisible({ id: LOGO_PREVIEW, timeout: 15_000 })
  await tapButton(web, 'Cancel')
  await checkpoint(ctx, web, 'logos-second-cancelled', {
    expect: [{ id: LOGO_PREVIEW, absent: true }, logosLeft(250)],
    readBack: async () => {
      expect(await rowCount(web)).equals(1)
      expect((await setup.api.sponsorState(setup.league)).logos).has.length(1)
    }
  })
  // The one <video> kept playing through every preview: no restart.
  const later = await sampleInWindow(web)
  expect(
    later > first || first > 1900,
    `the sample went on from ${first} to ${later}`
  ).equals(true)

  await tapCss(web, '[aria-label="Deactivate logo-960x540"]')
  await tapCss(web, '[data-testid="sponsor-confirm-deactivate"]')
  await checkpoint(ctx, web, 'logos-unused-removed', {
    expect: [logosLeft(300), { text: 'No logos yet. Add one above.' }],
    readBack: async () => {
      expect((await setup.api.sponsorState(setup.league)).logos).deep.equals([])
    }
  })
}

/** The whole reels flow (E2), on a window of `size`. */
async function reelsFlow(
  ctx: E2eContext,
  size: { width: number; height: number }
): Promise<void> {
  const setup = await league(ctx)
  const big = await clip(ctx.artifact('reel-4k-12s.mp4'), 12, 3840, 2160)
  const long = await clip(ctx.artifact('reel-20s.mp4'), 20, 640, 360)
  const web = await openThroughSettings(ctx, size, setup, 'Sponsor video reels')
  await checkpoint(ctx, web, 'reels-empty', {
    expect: [
      { text: 'No reels yet. Add one above.', timeout: 30_000 },
      reelsLeft('1,000')
    ]
  })
  await sampleInWindow(web)

  await web.m.uploadFile({ css: ADD_INPUT, path: long, timeout: 15_000 })
  await checkpoint(ctx, web, 'reels-too-long', {
    expect: [
      {
        text: 'This reel is 20 seconds. Reels must be 10 to 15 seconds long.',
        timeout: 30_000
      },
      { id: REEL_PREVIEW, absent: true }
    ]
  })

  await web.m.uploadFile({ css: ADD_INPUT, path: big, timeout: 15_000 })
  await checkpoint(ctx, web, 'reels-pending', {
    expect: [
      { id: REEL_PREVIEW, timeout: 180_000 },
      { text: 'Broadcasts for this reel' },
      { text: 'Up to 1,000 broadcast credits left' }
    ],
    readBack: async () => {
      // In the scoreboard's place: a third of the frame, at its top-left.
      const place = await web.page.evaluate(() => {
        const preview = document.querySelector(
          '[data-testid="sponsor-reel-preview"]'
        )
        const frame = document.querySelector(
          '[data-testid="sponsor-sample-video"]'
        )
        if (preview == null || frame == null) return null
        const box = preview.getBoundingClientRect()
        const outer = frame.getBoundingClientRect()
        const video = preview.querySelector('video')
        return {
          left: (box.left - outer.left) / outer.width,
          top: (box.top - outer.top) / outer.height,
          width: box.width / outer.width,
          playing: video != null && video.muted && video.loop
        }
      })
      expect(place, 'the preview').not.equals(null)
      expect(place!.left).closeTo(0.01, 0.01)
      expect(place!.top).closeTo(0.01, 0.01)
      expect(place!.width).closeTo(1 / 3, 0.01)
      expect(place!.playing, 'muted and looping').equals(true)
    }
  })
  await typeInto(web, 'input[aria-label="Broadcasts for this reel"]', '100')
  await tapButton(web, 'Accept')
  await checkpoint(ctx, web, 'reels-accepted', {
    expect: [
      reelsLeft('900'),
      { text: 'reel-4k-12s', timeout: 30_000 },
      { id: REEL_PREVIEW, absent: true }
    ],
    readBack: async () => {
      const state = await setup.api.sponsorState(setup.league)
      expect(state.reels).has.length(1)
      const stored = join(ctx.runDir, 'stored-reel.mp4')
      const bytes = Buffer.from(
        await (await fetch(state.reels[0].videoUrl)).arrayBuffer()
      )
      writeFileSync(stored, bytes)
      expect(bytes.length).at.most(3_200_000)
      const probed = await probe(stored)
      expect(probed.codec).equals('h264')
      expect(probed.width).at.most(640)
      expect(probed.height).at.most(360)
      expect(probed.fps).at.most(30.01)
    }
  })
  await web.m
    .takeScreenshot({ path: ctx.artifact('sponsor-reels-web.png') })
    .catch(() => undefined)
}

/** The page's widest element is no wider than its window. */
async function fitsTheWindow(web: WebSession): Promise<void> {
  const { scrollWidth, innerWidth } = await web.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }))
  expect(scrollWidth, 'no horizontal overflow').at.most(innerWidth)
}

/** The whole event-stream flow (E3), on a window of `size`. */
async function eventStreamFlow(
  ctx: E2eContext,
  size: { width: number; height: number }
): Promise<void> {
  const setup = await league(ctx)
  const logo = await picture(ctx.artifact('row-logo.jpg'), 300, 200, 'orange')
  const background = await picture(
    ctx.artifact('row-background.jpg'),
    1920,
    300,
    'navy'
  )
  // A row placed 25 hours ago: through the API, then dated back.
  const logoMedia = await setup.api.uploadSponsorMedia(
    setup.league,
    'rowLogo',
    'image/png',
    new Uint8Array(
      readFileSync(
        await picture(join(ctx.runDir, 'old-logo.png'), 128, 128, 'gray')
      )
    )
  )
  const backgroundMedia = await setup.api.uploadSponsorMedia(
    setup.league,
    'rowBackground',
    'image/png',
    new Uint8Array(
      readFileSync(
        await picture(join(ctx.runDir, 'old-background.png'), 1920, 224, 'gray')
      )
    )
  )
  const placed = await setup.api.addSponsorRow(setup.league, {
    logoMediaId: logoMedia.mediaId,
    backgroundMediaId: backgroundMedia.mediaId,
    title: 'Ridgeview Auto',
    message: 'Oil changes for every coach this season.',
    url: 'https://example.test/oil',
    textColor: 'dark',
    startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString()
  })
  const db = makeDatabase(nodeDatabaseUrl(stackHandle(ctx).databaseUrl))
  try {
    await db
      .updateTable('sponsor_rows')
      .set({ placed_at: new Date(Date.now() - 25 * 3_600_000) })
      .where('id', '=', placed.placements[0].id)
      .execute()
  } finally {
    await db.destroy()
  }

  const web = await openThroughSettings(
    ctx,
    size,
    setup,
    'Sponsor in event stream'
  )
  await checkpoint(ctx, web, 'rows-old-delete-only', {
    expect: [
      slotsLeft(9),
      { text: 'Ridgeview Auto', timeout: 30_000 },
      {
        text: 'Placed more than 24 hours ago: it can be deleted, but not edited or moved, and its slot stays used.'
      }
    ],
    readBack: async () => {
      const edit = await web.page.evaluate(
        () =>
          document.querySelector('[aria-label="Edit Ridgeview Auto"]') != null
      )
      expect(edit, 'no Edit after 24 hours').equals(false)
    }
  })

  // The refusals, typed into the empty form, which Cancel then clears.
  await typeIntoEmpty(web, 'input[aria-label="Title"]', 'Bayside Bakery Breads')
  await typeIntoEmpty(
    web,
    'input[aria-label="Website"]',
    'http://example.test/bread'
  )
  await checkpoint(ctx, web, 'rows-refusals', {
    expect: [
      { text: 'Titles can be at most 20 characters.' },
      { text: 'Use an https:// address.' }
    ]
  })
  await tapButton(web, 'Cancel')

  await web.m.uploadFile({
    css: '[data-testid="sponsor-logo-drop-input"]',
    path: logo,
    timeout: 15_000
  })
  await web.m.uploadFile({
    css: '[data-testid="sponsor-background-drop-input"]',
    path: background,
    timeout: 15_000
  })
  await typeIntoEmpty(web, 'input[aria-label="Title"]', 'Bayside Bakery')
  await typeIntoEmpty(
    web,
    'textarea[aria-label="Message"]',
    'Fresh bread after games.'
  )
  await typeIntoEmpty(
    web,
    'input[aria-label="Website"]',
    'https://example.test/bread'
  )
  await typeDateTime(web, '120120270530P')
  await web.m.tapOn({ text: 'White', timeout: 15_000 })
  await tapButton(web, 'Save')
  await checkpoint(ctx, web, 'rows-added', {
    expect: [slotsLeft(8), { text: 'Bayside Bakery' }],
    readBack: async () => {
      const state = await setup.api.sponsorState(setup.league)
      const row = state.placements.find(each => each.title === 'Bayside Bakery')
      expect(row, 'the new row').not.equals(undefined)
      expect(row!.textColor).equals('white')
      expect(row!.url).equals('https://example.test/bread')
      expect(row!.message).equals('Fresh bread after games.')
    }
  })
  await web.m
    .takeScreenshot({ path: ctx.artifact('sponsor-event-stream-web.png') })
    .catch(() => undefined)

  const before = (await setup.api.sponsorState(setup.league)).placements.find(
    each => each.title === 'Bayside Bakery'
  )!.startsAt
  await tapCss(web, '[aria-label="Edit Bayside Bakery"]')
  await typeDateTime(web, '120320270900A')
  await tapButton(web, 'Save')
  await checkpoint(ctx, web, 'rows-moved', {
    expect: [slotsLeft(8)],
    readBack: async () => {
      await eventually(async () => {
        const state = await setup.api.sponsorState(setup.league)
        const row = state.placements.find(
          each => each.title === 'Bayside Bakery'
        )!
        expect(row.startsAt).not.equals(before)
      }, 15_000)
    }
  })

  await tapCss(web, '[aria-label="Delete Bayside Bakery"]')
  await tapCss(web, '[data-testid="sponsor-confirm-delete"]')
  await checkpoint(ctx, web, 'rows-deleted-slot-back', {
    expect: [slotsLeft(9), { text: 'Bayside Bakery', absent: true }]
  })
  await tapCss(web, '[aria-label="Delete Ridgeview Auto"]')
  await tapCss(web, '[data-testid="sponsor-confirm-delete"]')
  await checkpoint(ctx, web, 'rows-old-deleted-slot-kept', {
    expect: [slotsLeft(9), { text: 'No sponsored rows yet. Add one below.' }],
    readBack: async () => {
      expect((await setup.api.sponsorState(setup.league)).keptSlots).equals(1)
      if (size.width < 500) await fitsTheWindow(web)
    }
  })
}

/** The leased phone of an app scenario, refused on another surface. */
function phoneOf(
  ctx: E2eContext,
  surface: 'ios-app' | 'android-app'
): { platform: 'ios' | 'android'; udid: string } {
  if (ctx.surface !== surface)
    throw new BlockedError(`runs on ${surface}, not ${ctx.surface}`)
  return {
    platform: surface === 'ios-app' ? 'ios' : 'android',
    udid: ctx.device('phone')
  }
}

/** Puts `files` in the phone's photo album. */
async function seedAlbum(
  phone: { platform: 'ios' | 'android'; udid: string },
  files: string[]
): Promise<void> {
  if (phone.platform === 'ios') {
    await run('xcrun', ['simctl', 'addmedia', phone.udid, ...files])
    return
  }
  for (const file of files) {
    const target = `/sdcard/Pictures/${file.replace(/.*\//, '')}`
    await run('adb', ['-s', phone.udid, 'push', file, target])
  }
  await run('adb', [
    '-s',
    phone.udid,
    'shell',
    'content',
    'call',
    '--method',
    'scan_volume',
    '--uri',
    'content://media',
    '--arg',
    'external_primary'
  ])
}

/**
 * Signs the AL admin in on the phone and opens League Settings, scrolled to
 * its Sponsor features row.
 */
async function phoneSettings(
  ctx: E2eContext,
  phone: { platform: 'ios' | 'android'; udid: string },
  setup: League
): Promise<any> {
  const device = await ctx.attach('phone', {
    platform: phone.platform,
    appId: APP_ID
  })
  await device.launchApp({ appId: APP_ID, stopApp: true })
  await signInWithPassword(device, setup.world.accounts.alAdmin)
  await openInApp({
    platform: phone.platform,
    udid: phone.udid,
    appId: APP_ID,
    link: appLink(`groups/league/${setup.league}/settings`),
    device,
    simulator: true
  })
  await device.scrollUntilVisible({
    element: { id: 'sponsor-features-row' },
    timeout: 30_000
  })
  return device
}

/**
 * Picks the album's newest item, the first cell of the system photo
 * picker's grid, tapping again while the picker is still up.
 */
async function pickNewest(
  device: any,
  platform: 'ios' | 'android'
): Promise<void> {
  const shown = platform === 'ios' ? 'Collections' : 'Photos'
  await device.assertVisible({ text: shown, timeout: 30_000 })
  for (let attempt = 0; attempt < 4; attempt++) {
    // The grid's cells fill in after the picker slides up.
    await new Promise(resolve => setTimeout(resolve, 2500))
    // Android's picker first shows its "only the photos you select" card
    // above the grid, which a fresh install always has.
    await device.tapOn({ point: platform === 'ios' ? '16%,23%' : '16%,58%' })
    const still: boolean = await device
      .assertVisible({ text: shown, timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
    if (!still) return
  }
}

/** E4: League Settings on the iPhone app, with the Premium pill. */
async function settingsApp(ctx: E2eContext): Promise<void> {
  const phone = phoneOf(ctx, 'ios-app')
  const setup = await league(ctx)
  const device = await phoneSettings(ctx, phone, setup)
  await ctx.checkpoint(
    'app-settings-row',
    {
      expect: [{ text: 'Sponsor features' }, { id: 'sponsor-premium-pill' }]
    },
    device
  )
  writeFileSync(
    ctx.artifact('league-settings-ios-app.png'),
    Buffer.from(await device.screenshot())
  )
}

/** E4: a logo picked from the album on the iPhone app, previewed and added. */
async function logosApp(ctx: E2eContext): Promise<void> {
  const phone = phoneOf(ctx, 'ios-app')
  const setup = await league(ctx)
  await seedAlbum(phone, [
    await picture(ctx.artifact('album-logo.png'), 960, 540, 'blue')
  ])
  const device = await phoneSettings(ctx, phone, setup)
  await device.tapOn({ id: 'sponsor-features-row' })
  await device.tapOn({ text: 'Sponsor video logos', timeout: 30_000 })
  await device.tapOn({ text: 'Choose from Photos', timeout: 30_000 })
  await pickNewest(device, phone.platform)
  await device.assertVisible({ id: LOGO_PREVIEW, timeout: 60_000 })
  await device.tapOn({ text: 'Credits for this logo' })
  await device.inputText({ text: '50' })
  await device.hideKeyboard().catch(() => undefined)
  await device.tapOn({ text: 'Accept' })
  // The balance is under the table, below the fold on a phone.
  await device.scrollUntilVisible({
    element: { text: 'Remaining game logo credits: 250 of 300' },
    timeout: 120_000
  })
  await ctx.checkpoint(
    'app-logo-added',
    {
      expect: [
        { text: 'Remaining game logo credits: 250 of 300', timeout: 60_000 }
      ],
      readBack: async () => {
        const state = await setup.api.sponsorState(setup.league)
        expect(state.logos).has.length(1)
        const stored = Buffer.from(
          await (await fetch(state.logos[0].imageUrl)).arrayBuffer()
        )
        const size = pngSize(stored)
        expect(size.width).at.most(480)
        expect(size.height).at.most(270)
      }
    },
    device
  )
  writeFileSync(
    ctx.artifact('sponsor-logos-ios.png'),
    Buffer.from(await device.screenshot())
  )
}

/** E4: a 1080p 60 fps clip picked on the Android app, shrunk and added. */
async function reelsApp(ctx: E2eContext): Promise<void> {
  const phone = phoneOf(ctx, 'android-app')
  const setup = await league(ctx)
  await seedAlbum(phone, [
    await clip(ctx.artifact('album-reel.mp4'), 12, 1920, 1080, 60)
  ])
  const device = await phoneSettings(ctx, phone, setup)
  await device.tapOn({ id: 'sponsor-features-row' })
  await device.tapOn({ text: 'Sponsor video reels', timeout: 30_000 })
  await device.tapOn({ text: 'Choose from Photos', timeout: 30_000 })
  await pickNewest(device, phone.platform)
  await device.assertVisible({ id: REEL_PREVIEW, timeout: 180_000 })
  await device.tapOn({ text: 'Broadcasts for this reel' })
  await device.inputText({ text: '100' })
  await device.hideKeyboard().catch(() => undefined)
  await device.tapOn({ text: 'Accept' })
  // The balance is under the table, below the fold on a phone.
  await device.scrollUntilVisible({
    element: { text: 'Remaining reel broadcast credits: 900 of 1,000' },
    timeout: 120_000
  })
  await ctx.checkpoint(
    'app-reel-added',
    {
      expect: [
        {
          text: 'Remaining reel broadcast credits: 900 of 1,000',
          timeout: 60_000
        }
      ],
      readBack: async () => {
        const state = await setup.api.sponsorState(setup.league)
        expect(state.reels).has.length(1)
        const stored = join(ctx.runDir, 'stored-app-reel.mp4')
        writeFileSync(
          stored,
          Buffer.from(
            await (await fetch(state.reels[0].videoUrl)).arrayBuffer()
          )
        )
        const probed = await probe(stored)
        expect(probed.width).at.most(640)
        expect(probed.height).at.most(360)
        expect(probed.fps).at.most(30.01)
      }
    },
    device
  )
  writeFileSync(
    ctx.artifact('sponsor-reels-android.png'),
    Buffer.from(await device.screenshot())
  )
}

function web(
  flow: (
    ctx: E2eContext,
    size: { width: number; height: number }
  ) => Promise<void>,
  size: { width: number; height: number }
): (ctx: E2eContext) => Promise<void> {
  return async ctx => {
    if (ctx.surface !== 'web-chromium')
      throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
    await flow(ctx, size)
  }
}

export default defineE2e({
  id: 'schedule/sponsors/admin',
  title:
    'A league administrator sets up sponsor logos, reels and sponsored Schedule rows on the real API, shrinking uploads on the web and on the phones',
  kind: 'e2e',
  covers: [
    'src/app/sponsors/**',
    'src/app/player/sponsors/overlayRects.ts',
    'src/app/screens/GroupSettingsScreen.tsx',
    'src/app/navigation/routes.ts',
    'src/common/sponsors/**',
    'src/server/routes/sponsors.ts',
    'src/server/sponsors/**',
    'ios/TeamStation/SponsorMedia/**',
    'android/app/src/main/java/app/teamstation/app/sponsormedia/**'
  ],
  stack: 'isolated',
  fixtures: ['packed-league', 'sponsors'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
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
  minutes: 12,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    'logos-desktop': web(logosFlow, DESKTOP),
    'logos-phone': web(logosFlow, PHONE),
    'reels-desktop': web(reelsFlow, DESKTOP),
    'reels-phone': web(reelsFlow, PHONE),
    'reels-no-webcodecs': async ctx => {
      if (ctx.surface !== 'web-chromium')
        throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
      const setup = await league(ctx)
      const reel = await clip(ctx.artifact('reel-12s.mp4'), 12, 1280, 720)
      const page = await openThroughSettings(
        ctx,
        DESKTOP,
        setup,
        'Sponsor video reels',
        { beforeLoad: 'delete window.VideoEncoder' }
      )
      await page.m.uploadFile({ css: ADD_INPUT, path: reel, timeout: 15_000 })
      await checkpoint(ctx, page, 'reels-no-webcodecs', {
        expect: [
          { text: NO_WEBCODECS, timeout: 30_000 },
          { id: REEL_PREVIEW, absent: true }
        ],
        readBack: async () => {
          expect(
            (await setup.api.sponsorState(setup.league)).reels
          ).deep.equals([])
        }
      })
      await page.m
        .takeScreenshot({ path: ctx.artifact('reels-no-webcodecs-web.png') })
        .catch(() => undefined)
    },
    'event-stream-desktop': web(eventStreamFlow, DESKTOP),
    'event-stream-phone': web(eventStreamFlow, PHONE),
    'logos-ios-app': logosApp,
    'reels-android-app': reelsApp,
    'settings-ios-app': settingsApp
  }
})
