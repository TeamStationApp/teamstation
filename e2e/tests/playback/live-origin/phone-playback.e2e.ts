import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { decodeFirstFrame, encode } from '../../../core/video'
import { appLink, pointAtStack } from '../../../rigs/app/pointAtStack'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import {
  endLiveStream,
  liveCamera,
  pause,
  until
} from '../../../rigs/media/liveCamera'
import { apiToken } from '../../../rigs/media/recordingSeek'
import {
  stackApi,
  stackControl,
  stackMedia,
  untilBroadcast
} from '../../../rigs/media/stackSpace'

/**
 * A live stream from the Space on an iPhone, in Safari and in the app: the
 * player plays on for 25 s while it is live, and reaches the recording's
 * end once the camera is ended. Safari's position is its progress labels;
 * the app's is the wall clock the broadcaster burns into the picture, read
 * off a screenshot of the card (`gameVideoOpen`), independently of
 * AVPlayer's live duration and its auto-hidden labels.
 */

interface Node {
  id?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}

const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

const APP = 'teamstation-ios'

async function playsToTheEnd(ctx: HarnessContext): Promise<void> {
  const safari = ctx.surface === 'web-safari-ios'
  const control = stackControl(ctx)
  const media = stackMedia(control)
  const api = stackApi(ctx)
  const origin = ctx.stack.origin.replace(/\/+$/, '')
  const world = await ctx.fixture('streaming')
  const gameId = world.ids.game
  const token = await apiToken(api, world.accounts.coach)
  await clearSignInLimits(ctx)

  let m: any
  if (safari) {
    m = await ctx.mobileBrowser('phone', `${origin}/sign-in`)
  } else {
    const appId = ctx.app(APP)
    m = ctx.attached('phone')
    await m.launchApp({ appId, clearState: true })
    // A clear forgets the server: the link points the app back at the stack.
    await pointAtStack(m, origin, appId)
  }
  await m.setOrientation('PORTRAIT')
  await ctx.signIn('viewer', m)
  // Safari may offer to save the password once; a screen without it is the
  // ordinary case.
  if (
    flatten((await m.hierarchy()) as Node).some(node => node.text === 'Not Now')
  )
    await m.tapOn({ text: 'Not Now' })

  const camera = await liveCamera(api, token, gameId, 'Live origin')
  const show = await media.broadcast({
    url: camera.url,
    duration: 120,
    size: '1280x720'
  })
  await pause(show.t0 + 10_000 - Date.now())
  let shots = 0
  const shot = async (name: string): Promise<string> => {
    const file = ctx.artifact(`${ctx.surface}-${name}.png`)
    await m.takeScreenshot({ path: file })
    shots++
    return file
  }

  const clocks = async (): Promise<number[]> => {
    const tree = (await m.hierarchy()) as Node
    if (safari) {
      return flatten(tree)
        .flatMap(node => {
          const match = /^(\d{1,2}):(\d{2})$/.exec(node.text ?? '')
          return match == null ? [] : [Number(match[1]) * 60 + Number(match[2])]
        })
        .filter(value => value < 240)
    }
    const corner = flatten(tree).find(
      node => node.id === 'gameVideoOpen'
    )?.bounds
    const screen = tree.bounds
    if (corner == null || screen == null) return []
    const margin = screen.width - corner.x - corner.width
    const width = screen.width - 2 * margin
    const w = Math.round(screen.width)
    const h = Math.round(screen.height)
    const pixels = await decodeFirstFrame(await shot('probe'), {
      pixFmt: 'rgb24',
      width: w,
      height: h
    })
    if (pixels == null) return []
    const brightness = (x: number, y: number): number => {
      const at =
        (Math.round(corner.y + (y * width) / 1280) * w +
          Math.round(margin + (x * width) / 1280)) *
        3
      return (
        0.299 * pixels[at] + 0.587 * pixels[at + 1] + 0.114 * pixels[at + 2]
      )
    }
    // The broadcaster's 32-bit marker: 32 cells, then an always-white
    // sentinel, on a black strip of a 720p frame.
    if (brightness(40 + 32 * 36 + 16, 664) < 160 || brightness(40, 690) > 96)
      return []
    let low = 0
    for (let bit = 0; bit < 32; bit++)
      if (brightness(40 + bit * 36 + 16, 664) > 128) low += 2 ** bit
    const span = 2 ** 32
    const wall = low + Math.round((Date.now() - low) / span) * span
    if (Math.abs(wall - Date.now()) > 300000) return []
    return [(wall - show.t0) / 1000]
  }

  const path = `games/${gameId}?tab=watch&video=${camera.videoId}`
  await m.openLink(
    safari
      ? { link: `${origin}/${path}`, browser: true }
      : { link: appLink(path) }
  )
  await m.assertVisible({ text: 'Watch full screen', timeout: 30000 })
  // The portrait card's central square is its play/pause control, the
  // element a person touches.
  await m.tapOn({ point: '50%,55%' })
  await until(
    `${ctx.surface}: playback to start`,
    async () => ((await clocks())[0] ?? 0) > 0,
    30_000,
    500
  )

  const samples: Array<{ elapsed: number; positions: number[] }> = []
  const painted: Array<{ image: Uint8Array; at: number }> = []
  const began = Date.now()
  for (let i = 0; i <= 6; i++) {
    if (i > 0) await pause(5000)
    const elapsed = (Date.now() - began) / 1000
    samples.push({ elapsed, positions: await clocks() })
    painted.push({
      image: readFileSync(await shot(`sample-${i}`)),
      at: elapsed
    })
  }
  // A physical iPhone's screen is sampled, not recorded: the samples as a
  // labelled evidence sequence.
  encode(
    painted,
    ctx.artifact(`live-${ctx.surface}.mp4`),
    join(ctx.runDir, 'encode')
  )
  writeFileSync(
    ctx.artifact(`device-pass-${ctx.surface}.log`),
    `${JSON.stringify(samples)}\nOn-device functional evidence sampled every five seconds, as ${shots} screenshots; external frame pacing is unmeasured.\n`
  )
  const first = Math.min(...samples[0].positions)
  const last = Math.min(...samples.at(-1)!.positions)
  expect(
    Number.isFinite(first) && Number.isFinite(last) && last - first >= 25,
    `${ctx.surface}: the displayed position advanced by 25 seconds (${first} to ${last})`
  ).equals(true)

  const published = await untilBroadcast(
    media,
    show.id,
    'the broadcast to end',
    status => status.exit != null,
    { timeoutMs: 300_000 }
  )
  expect(published.exit, 'the broadcaster published').equals(0)
  expect(await endLiveStream(api, token, gameId, camera)).equals(200)
  await until(
    'the recording to be verified in the Space',
    async () =>
      (
        await control.sql(
          'SELECT spaces_verified_at FROM videos WHERE id = $1',
          [camera.videoId]
        )
      ).rows[0]?.spaces_verified_at != null,
    120_000,
    1000
  )
  const duration = Number(
    (
      await control.sql('SELECT duration_sec FROM videos WHERE id = $1', [
        camera.videoId
      ])
    ).rows[0]?.duration_sec ?? 0
  )
  await until(
    `${ctx.surface}: the player to reach the recording's end`,
    async () => {
      const positions = await clocks()
      return (
        positions.length >= (safari ? 2 : 1) &&
        Math.min(...positions) >= Math.floor(duration) - 1
      )
    },
    60_000,
    1000
  )
  await shot('ended')
}

export default defineHarness({
  id: 'playback/live-origin/phone-playback',
  title:
    'An iPhone plays a live stream from the Space, in Safari and in the app, on to the recording’s end',
  kind: 'e2e',
  covers: [
    'src/server/live/originPublish.ts',
    'src/server/media/spacesHls.ts',
    'src/server/routes/media.ts',
    'src/app/player/**'
  ],
  stack: 'isolated',
  fixtures: ['streaming'],
  exclusive: false,
  surfaces: {
    // A phone's own video decoder plays HEVC: a physical iPhone, never a
    // simulator, whose player is not the phone's.
    'web-safari-ios': {
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'never' }]
    },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'never' }]
    }
  },
  services: [],
  apps: [APP],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { 'plays-to-the-end': playsToTheEnd }
})
