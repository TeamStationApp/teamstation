import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { promisify } from 'node:util'

import { expect } from 'chai'

import { TeamStationClient } from '../../../../src/common/api'
import {
  defaultSponsorSettings,
  type LogoPlacement,
  type NodeSettings
} from '../../../../src/common/nodeSettings'
import type { FixtureAccount } from '../../../../src/server/dev/fixtures/accounts'
import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { apiToken } from '../../../rigs/media/recordingSeek'
import {
  acceptLogo,
  acceptReel,
  endLive,
  goLive,
  REEL_MS,
  type ReelSetup,
  reelsRead,
  reelWorld,
  scorer
} from '../../../rigs/media/sponsorReelGame'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * The node administrator places sponsor logos and reels (#220): on Node
 * Administration's Sponsor settings, the single camera's logo 10% in from
 * the right and the one-camera reel 25% of the screen wide, which a game
 * opened again draws there; Reset to defaults then Save puts back 5% and
 * exactly a third. And the sponsor sample video: refused when it is not
 * 1080p, faster than 60 fps, longer than two minutes or larger than 120 MB,
 * and once a 1080p clip is accepted, a league with no footage previews it.
 *
 * The scenarios change node-wide settings, so they run alone on their stack
 * and put the defaults back.
 */

const DESKTOP = { width: 1280, height: 800 }
const run = promisify(execFile)
const ffmpeg = (): string => process.env.TS_FFMPEG ?? 'ffmpeg'

const SINGLE_SIDE = 'Logo — single camera: side margin'
const LANDSCAPE1_WIDTH = 'Reel — landscape, 1 camera: largest width'
const SAMPLE_INPUT = '[data-testid="sponsor-sample-input"]'

/** A label as a quoted CSS attribute value: backslashes and quotes escaped. */
const cssString = (label: string): string =>
  `"${label.replace(/[\\"]/g, '\\$&')}"`
const byLabel = (label: string): string => `[aria-label=${cssString(label)}]`
const byLabelStart = (label: string): string =>
  `[aria-label^=${cssString(label)}]`

/** Makes `account` a node administrator, for the scenario only. */
async function nodeAdmin(
  setup: ReelSetup,
  account: FixtureAccount,
  isAdmin: boolean
): Promise<void> {
  await setup.db
    .updateTable('users')
    .set({ is_admin: isAdmin })
    .where('id', '=', account.userId as never)
    .execute()
}

/** Puts the node's sponsor settings back to the defaults. */
async function resetSponsors(client: TeamStationClient): Promise<void> {
  const settings = await client.nodeSettings()
  await client.setNodeSettings({
    ...settings,
    sponsors: defaultSponsorSettings
  })
}

/** Signs `account` in on the web. */
async function signIn(
  ctx: E2eContext,
  account: FixtureAccount
): Promise<WebSession> {
  const web = await ctx.browser(DESKTOP, { h264: true })
  const { m } = web
  await m.openLink({ link: ctx.stack.origin })
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
  return web
}

/** Taps the element at `css` once it is in the middle of the window. */
async function tapCss(web: WebSession, css: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = document.querySelector(${JSON.stringify(css)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ css, timeout: 15_000 })
}

/** Scrolls the element at `css` to the middle of the window, for a screenshot. */
async function scrollTo(web: WebSession, css: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = document.querySelector(${JSON.stringify(css)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
}

/** Scrolls the sample video's row and its Upload to the middle of the window. */
async function scrollToSample(web: WebSession): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = [...document.querySelectorAll('[role="button"]')]
        .find(node => node.textContent === 'Upload sample video')
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
}

/** Opens Node Administration and waits for its sponsor settings. */
async function openNode(ctx: E2eContext, web: WebSession): Promise<void> {
  await web.m.openLink({ link: `${ctx.stack.origin}/node` })
  await eventually(async () => {
    const shown = await web.page.evaluate(
      (css: string) => document.querySelector(css) != null,
      byLabelStart(`${SINGLE_SIDE}: `)
    )
    expect(shown, 'the sponsor settings').equals(true)
  }, 60_000)
}

/** The value a sponsor row shows, by its name. */
async function shownValue(web: WebSession, name: string): Promise<string> {
  const label = await web.page.evaluate(
    // In the page, which has no helpers for `?.` or `??`.
    (css: string) => {
      const row = document.querySelector(css)
      return row == null ? null : row.getAttribute('aria-label')
    },
    byLabelStart(`${name}: `)
  )
  expect(label, name).not.equals(null)
  return label!.slice(name.length + 2)
}

/** Opens a row's wheel, taps `option` on it, and uses it. */
async function pick(
  web: WebSession,
  name: string,
  option: string
): Promise<void> {
  await tapCss(web, byLabelStart(`${name}: `))
  await tapCss(web, byLabel(option))
  await web.m.tapOn({ text: 'Use', timeout: 15_000 })
  await eventually(async () => {
    expect(await shownValue(web, name)).equals(option.split(' ').at(-1))
  }, 15_000)
}

/** The button reading `label`, tapped once it is in the middle. */
async function tapButton(web: WebSession, label: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = [...document.querySelectorAll('[role="button"]')]
        .find(node => node.textContent === ${JSON.stringify(label)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ text: label, timeout: 15_000 })
}

/**
 * The single-camera logo's rect against where `placement` puts it on the
 * card's picture, the `contain` box of its video.
 */
async function logoAgainst(
  web: WebSession,
  placement: LogoPlacement,
  natural: { width: number; height: number }
): Promise<{ drawn: number[]; expected: number[] } | null> {
  return await web.page.evaluate(
    (args: {
      placement: LogoPlacement
      natural: { width: number; height: number }
    }) => {
      const logo = document.querySelector<HTMLElement>(
        '[data-testid="sponsor-logo"]'
      )
      if (logo == null) return null
      let holder = logo.parentElement
      while (holder != null && holder.querySelector('video') == null)
        holder = holder.parentElement
      if (holder == null) return null
      const video = holder.querySelector('video')!
      const box = holder.getBoundingClientRect()
      const aspect =
        video.videoWidth > 0 && video.videoHeight > 0
          ? video.videoWidth / video.videoHeight
          : box.width / box.height
      const fitW = Math.min(box.width, box.height * aspect)
      const fitH = fitW / aspect
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
      return {
        drawn: [drawn.left, drawn.top, drawn.width, drawn.height],
        expected: [
          tile.x + tile.w - args.placement.side * tile.w - w,
          tile.y + args.placement.top * tile.h,
          w,
          h
        ]
      }
    },
    { placement, natural }
  )
}

/** The reel's width while it plays, once it is drawn. */
async function reelWidth(web: WebSession): Promise<number> {
  let width = 0
  await eventually(async () => {
    const rect = await web.page.evaluate(() => {
      const reel = document.querySelector('[data-testid="sponsor-reel"]')
      return reel == null ? null : reel.getBoundingClientRect().width
    })
    expect(rect, 'the reel').not.equals(null)
    width = rect!
  }, 60_000)
  return width
}

/** A recorded game with the AL logo and one half-inning reel. */
async function recordedGame(
  ctx: E2eContext,
  setup: ReelSetup
): Promise<{ video: string; reelAt: number; afterReel: number }> {
  await acceptLogo(ctx, setup)
  await acceptReel(ctx, setup)
  const { cameras, videos } = await goLive(ctx, setup, 60 * 60_000)
  let startMs = 0
  try {
    await new Promise(resolve => setTimeout(resolve, 30_000))
    await (await scorer(setup)).endHalf()
    startMs = (await reelsRead(setup, 1, 30_000)).reels[0].startMs
    await new Promise(resolve =>
      setTimeout(resolve, Math.max(0, startMs + REEL_MS + 20_000 - Date.now()))
    )
  } finally {
    await endLive(setup, cameras)
  }
  const row = await setup.db
    .selectFrom('videos')
    .select('start_at')
    .where('id', '=', videos[0])
    .executeTakeFirstOrThrow()
  const start = new Date(row.start_at ?? 0).getTime()
  return {
    video: videos[0],
    reelAt: (startMs + 2000 - start) / 1000,
    afterReel: (startMs + REEL_MS + 3000 - start) / 1000
  }
}

/**
 * E15: the node administrator moves the single camera's logo to 10% from
 * the right and narrows the one-camera reel to 25% of the screen; the game
 * opened again draws them there; Reset to defaults and Save put back 5% and
 * exactly a third.
 */
async function editAndReset(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  const account = setup.world.accounts.alAdmin
  await nodeAdmin(setup, account, true)
  const report: string[] = []
  try {
    await resetSponsors(setup.admin)
    const game = await recordedGame(ctx, setup)
    const card = `${ctx.stack.origin}/games/${setup.gameId}?video=${game.video}`
    const landscape1 = `${ctx.stack.origin}/games/${setup.gameId}?angles=${game.video}&t=${game.reelAt.toFixed(1)}`

    // Before: the defaults.
    const viewer = await signIn(ctx, setup.world.accounts.yankeesPlayer)
    await viewer.m.openLink({ link: landscape1 })
    const before = await reelWidth(viewer)
    report.push(`landscape1 reel at the default third: ${before.toFixed(1)} px`)

    const web = await signIn(ctx, account)
    await openNode(ctx, web)
    expect(await shownValue(web, SINGLE_SIDE)).equals('5%')
    expect(await shownValue(web, LANDSCAPE1_WIDTH)).equals('33⅓%')
    // The sponsor groups, from their header down.
    await scrollTo(web, byLabelStart(`${SINGLE_SIDE}: `))
    await web.m
      .takeScreenshot({ path: ctx.artifact('node-settings-web-after.png') })
      .catch(() => undefined)
    await pick(web, SINGLE_SIDE, 'Side margin 10%')
    await pick(web, LANDSCAPE1_WIDTH, 'Largest width 25%')
    await tapButton(web, 'Save')
    await ctx.checkpoint('placed', {
      expect: [{ text: 'Saved.', timeout: 30_000 }],
      readBack: async () => {
        const stored = (await setup.admin.nodeSettings()).sponsors
        expect(stored.logo.single).deep.equals({
          ...defaultSponsorSettings.logo.single,
          side: 0.1
        })
        expect(stored.reel.landscape1).deep.equals({
          maxWidth: 0.25,
          maxHeight: 1 / 3
        })
        expect(stored.logo.grid).deep.equals(defaultSponsorSettings.logo.grid)
      }
    })

    // The game opened again: its logo 10% in, its reel 25% wide.
    const sponsors = await setup.player.gameSponsors(setup.gameId)
    expect(sponsors.overlay.logo.single.side).equals(0.1)
    expect(sponsors.overlay.reel.landscape1.maxWidth).equals(0.25)
    await viewer.m.openLink({ link: card })
    let logo: Awaited<ReturnType<typeof logoAgainst>> = null
    await eventually(async () => {
      logo = await logoAgainst(viewer, sponsors.overlay.logo.single, {
        width: sponsors.logo!.width,
        height: sponsors.logo!.height
      })
      expect(logo, 'the logo').not.equals(null)
      logo!.drawn.forEach((value, index) => {
        expect(value).closeTo(logo!.expected[index], 1.5)
      })
    }, 60_000)
    report.push(
      `single logo drawn ${logo!.drawn.map(n => n.toFixed(1)).join(' ')} expected (side 10%) ${logo!.expected.map(n => n.toFixed(1)).join(' ')}`
    )
    await viewer.m
      .takeScreenshot({ path: ctx.artifact('logo-side-10-web.png') })
      .catch(() => undefined)
    await viewer.m.openLink({ link: landscape1 })
    const after = await reelWidth(viewer)
    report.push(`landscape1 reel at 25%: ${after.toFixed(1)} px`)
    expect(after, 'a quarter of the screen').at.most(DESKTOP.width * 0.25 + 1)
    expect(after / before, 'a quarter against a third').closeTo(0.75, 0.03)
    await viewer.m
      .takeScreenshot({ path: ctx.artifact('reel-landscape1-25-web.png') })
      .catch(() => undefined)

    // Reset to defaults, then Save: 5% and exactly a third.
    await openNode(ctx, web)
    expect(await shownValue(web, SINGLE_SIDE)).equals('10%')
    await tapButton(web, 'Reset to defaults')
    expect(await shownValue(web, SINGLE_SIDE)).equals('5%')
    expect(await shownValue(web, LANDSCAPE1_WIDTH)).equals('33⅓%')
    await tapButton(web, 'Save')
    await ctx.checkpoint('reset', {
      expect: [{ text: 'Saved.', timeout: 30_000 }],
      readBack: async () => {
        const stored: NodeSettings = await setup.admin.nodeSettings()
        expect(stored.sponsors).deep.equals(defaultSponsorSettings)
        expect(stored.sponsors.reel.landscape1.maxWidth).equals(1 / 3)
      }
    })
    await openNode(ctx, web)
    expect(await shownValue(web, LANDSCAPE1_WIDTH)).equals('33⅓%')
    await viewer.m.openLink({ link: landscape1 })
    const reset = await reelWidth(viewer)
    report.push(`landscape1 reel after Reset: ${reset.toFixed(1)} px`)
    expect(reset).closeTo(before, 1)
    writeFileSync(
      ctx.artifact('sponsor-placements.txt'),
      `${report.join('\n')}\n`
    )
  } finally {
    await resetSponsors(setup.admin).catch(() => undefined)
    await nodeAdmin(setup, account, false).catch(() => undefined)
    await setup.db.destroy()
  }
}

/** A synthetic clip, `seconds` long at `width` × `height` and `fps`. */
async function clip(
  path: string,
  seconds: number,
  width: number,
  height: number,
  fps: number
): Promise<string> {
  await run(ffmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    // About 30 MB a minute, as a camera's clip would be.
    '-b:v',
    '4M',
    '-movflags',
    '+faststart',
    path
  ])
  return path
}

/**
 * PUTs `body` to the sample route as curl would, and appends the exchange to
 * `sample-upload.log` without the token.
 */
async function putSample(
  ctx: E2eContext,
  token: string,
  name: string,
  body: Buffer
): Promise<{ status: number; message: string }> {
  const url = new URL(`${stackHandle(ctx).api}/node/sponsor-sample`)
  const answer = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      let answered = false
      const req = httpsRequest(
        url,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'video/mp4',
            'content-length': String(body.length)
          }
        },
        res => {
          answered = true
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (part: string) => (text += part))
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, text })
          })
        }
      )
      req.on('error', error => {
        if (!answered) reject(error)
      })
      req.end(body)
    }
  )
  appendFileSync(
    ctx.artifact('sample-upload.log'),
    `$ curl -sS -X PUT "$STACK/api/v1/node/sponsor-sample" -H 'content-type: video/mp4' --data-binary @${name}   # ${body.length.toLocaleString('en-US')} bytes\nHTTP ${answer.status} ${answer.text}\n\n`
  )
  let message = ''
  try {
    message = (JSON.parse(answer.text) as { message?: string }).message ?? ''
  } catch {
    /* Not JSON: told as it is. */
  }
  return { status: answer.status, message }
}

/**
 * E16: the node administrator's sample video. Refused, each with its
 * sentence on the screen and from the route: 720p, 61 fps, 121 s, and 130 MB
 * at the cap. A 1080p 30 fps 60 s H.264 clip is accepted, and the National
 * League, which has no footage, previews it in its logos screen.
 */
async function sampleUpload(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  const account = setup.world.accounts.alAdmin
  const nlAdmin = new TeamStationClient({
    baseUrl: stackHandle(ctx).api,
    token: await apiToken(stackHandle(ctx).api, setup.world.accounts.nlAdmin)
  })
  await nodeAdmin(setup, account, true)
  try {
    await resetSponsors(setup.admin)
    const files = {
      p720: await clip(ctx.artifact('sample-720p.mp4'), 10, 1280, 720, 30),
      fps61: await clip(ctx.artifact('sample-61fps.mp4'), 4, 1920, 1080, 61),
      long121: await clip(ctx.artifact('sample-121s.mp4'), 121, 1920, 1080, 1),
      good: await clip(ctx.artifact('sample-1080p-60s.mp4'), 60, 1920, 1080, 30)
    }
    const big = ctx.artifact('sample-130mb.mp4')
    writeFileSync(big, Buffer.alloc(130_000_000, 7))

    // Before any upload the National League previews the default clip.
    const before = await nlAdmin.sponsorSample(setup.world.ids.nationalLeague)
    expect(before.kind).equals('node')
    expect(before.url).matches(/\/sponsors\/sample\/default\.mp4$/)

    // The route's own refusals, as curl sends them.
    const token = setup.admin.token!
    for (const [name, path, sentence] of [
      [
        'sample-720p.mp4',
        files.p720,
        'The sample video must be 1,920 × 1,080.'
      ],
      [
        'sample-61fps.mp4',
        files.fps61,
        'The sample video can be at most 60 frames a second.'
      ],
      [
        'sample-121s.mp4',
        files.long121,
        'The sample video can be at most 2 minutes long.'
      ],
      ['sample-130mb.mp4', big, 'The sample video can be at most 120 MB.']
    ] as const) {
      const answer = await putSample(ctx, token, name, readFileSync(path))
      expect(answer, name).deep.equals({ status: 400, message: sentence })
    }
    expect((await setup.admin.nodeSettings()).sponsors.sampleKey).equals(null)

    // And on the screen.
    const web = await signIn(ctx, account)
    await openNode(ctx, web)
    await scrollToSample(web)
    await ctx.checkpoint('default-clip', {
      expect: [{ text: 'Default clip' }, { text: 'Upload sample video' }]
    })
    for (const [path, sentence] of [
      [files.p720, 'The sample video must be 1,920 × 1,080.'],
      [files.fps61, 'The sample video can be at most 60 frames a second.'],
      [files.long121, 'The sample video can be at most 2 minutes long.'],
      [big, 'The sample video can be at most 120 MB.']
    ] as const) {
      await web.m.uploadFile({ css: SAMPLE_INPUT, path, timeout: 15_000 })
      await web.m.assertVisible({ text: sentence, timeout: 120_000 })
    }
    await scrollToSample(web)
    await web.m
      .takeScreenshot({ path: ctx.artifact('sample-refused-web.png') })
      .catch(() => undefined)
    expect((await setup.admin.nodeSettings()).sponsors.sampleKey).equals(null)

    await web.m.uploadFile({
      css: SAMPLE_INPUT,
      path: files.good,
      timeout: 15_000
    })
    const day = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    })
    // The row is far down the card: once it reads so, bring it into view.
    await eventually(async () => {
      const shown = await web.page.evaluate((wanted: string) => {
        // In the page, which has no helpers for `?.` or `??`.
        return String(document.body.textContent).includes(wanted)
      }, `Uploaded ${day}`)
      expect(shown, 'the uploaded day').equals(true)
    }, 180_000)
    await scrollToSample(web)
    await ctx.checkpoint('uploaded', {
      expect: [{ text: `Uploaded ${day}`, timeout: 180_000 }],
      readBack: async () => {
        const key = (await setup.admin.nodeSettings()).sponsors.sampleKey
        expect(key).matches(/^sponsors\/sample\/\d{4}-\d{2}-\d{2}-smd_/)
      }
    })
    await scrollToSample(web)
    await web.m
      .takeScreenshot({ path: ctx.artifact('sample-uploaded-web.png') })
      .catch(() => undefined)
    const good = readFileSync(files.good)
    const accepted = await putSample(ctx, token, 'sample-1080p-60s.mp4', good)
    expect(accepted.status, 'the route takes it too').equals(200)
    // The route's own upload is the node's sample now.
    const key = (await setup.admin.nodeSettings()).sponsors.sampleKey!

    // The National League, with no footage, previews the node's sample.
    const after = await nlAdmin.sponsorSample(setup.world.ids.nationalLeague)
    expect(after.kind).equals('node')
    expect(after.url).not.matches(/default\.mp4$/)
    const nl = await signIn(ctx, setup.world.accounts.nlAdmin)
    await nl.m.openLink({
      link: `${ctx.stack.origin}/groups/league/${encodeURIComponent(setup.world.ids.nationalLeague)}/settings`
    })
    await tapCss(nl, '[data-testid="sponsor-features-row"]')
    await nl.m.assertVisible({ text: 'Sponsor Features', timeout: 30_000 })
    await nl.m.tapOn({ text: 'Sponsor video logos', timeout: 15_000 })
    await ctx.checkpoint('nl-previews-sample', {
      expect: [{ id: 'sponsor-sample-video', timeout: 60_000 }],
      readBack: async () => {
        await eventually(async () => {
          const playing = await nl.page.evaluate(() => {
            const video = document.querySelector<HTMLVideoElement>(
              'video[aria-label="Sample game video"]'
            )
            return video == null
              ? null
              : { src: video.currentSrc, ready: video.readyState }
          })
          expect(playing, 'the sample video').not.equals(null)
          expect(playing!.src).equals(after.url)
          expect(playing!.ready, 'it plays').at.least(2)
        }, 60_000)
        expect(after.url.endsWith(`/${key}`), 'the uploaded sample').equals(
          true
        )
      }
    })
    await nl.m
      .takeScreenshot({ path: ctx.artifact('sample-preview-nl-web.png') })
      .catch(() => undefined)
  } finally {
    await resetSponsors(setup.admin).catch(() => undefined)
    await nodeAdmin(setup, account, false).catch(() => undefined)
    await setup.db.destroy()
  }
}

export default defineE2e({
  id: 'platform/node-admin/sponsor-settings',
  title:
    'The node administrator places sponsor logos and reels per layout, resets them, and replaces the sponsor sample video',
  kind: 'e2e',
  covers: [
    'src/app/screens/NodeSettingsCard.tsx',
    'src/app/sponsors/SponsorSampleUpload.tsx',
    'src/common/nodeSettings.ts',
    'src/server/nodeSettings.ts',
    'src/server/routes/nodeSampleVideo.ts',
    'src/server/sponsors/sample.ts'
  ],
  stack: 'isolated',
  fixtures: ['sponsors'],
  // Node-wide settings: nothing else runs on the stack meanwhile.
  exclusive: true,
  surfaces: {
    'web-chromium': { devices: [] }
  },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 12,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    'edit-and-reset': editAndReset,
    'sample-upload': sampleUpload
  }
})
