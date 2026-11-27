import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import type { HTTPResponse } from '../../../core/web'
import {
  endLiveStream,
  type LiveCamera,
  liveCamera,
  pause,
  sessionOnBrowser,
  until
} from '../../../rigs/media/liveCamera'
import { apiToken } from '../../../rigs/media/recordingSeek'
import {
  type Broadcast,
  stackApi,
  stackControl,
  stackMedia,
  untilBroadcast
} from '../../../rigs/media/stackSpace'

/**
 * A live stream plays from the Space, never from the media of the machine
 * that took it in. A camera publishes into the stack's ingest (the stack's
 * fake broadcaster), and once its pieces are in the Space the API's live
 * playback is the Space's event playlist, whose fragments a player reads
 * straight from the Space. Chrome on this machine plays it live to its end;
 * the closed recording is the fragment playlist, with no `video.mp4`.
 *
 * The legacy run had a second API process with a media root of its own as
 * the viewer's node, and read its request trace and the fake Space's log.
 * One stack has one API: what the player asked for is read from the page's
 * own network instead, and the checks that need a node with no ingest of its
 * own (its media root stays empty; the outage run through it) are blocked.
 */

interface Started {
  api: string
  token: string
  gameId: string
  camera: LiveCamera
  show: Broadcast
  viewer: { email: string; password: string }
  media: ReturnType<typeof stackMedia>
  control: ReturnType<typeof stackControl>
}

async function start(ctx: HarnessContext, seconds: number): Promise<Started> {
  const control = stackControl(ctx)
  const media = stackMedia(control)
  const api = stackApi(ctx)
  const world = await ctx.fixture('streaming')
  const token = await apiToken(api, world.accounts.coach)
  const camera = await liveCamera(api, token, world.ids.game, 'Live origin')
  const show = await media.broadcast({
    url: camera.url,
    duration: seconds,
    size: '1280x720'
  })
  await pause(show.t0 + 10_000 - Date.now())
  return {
    api,
    token,
    gameId: world.ids.game,
    camera,
    show,
    viewer: world.accounts.viewer,
    media,
    control
  }
}

async function playback(
  s: Started
): Promise<{ url?: string; unavailable: boolean }> {
  return (await (
    await fetch(`${s.api}/videos/${s.camera.videoId}/playback`, {
      headers: { authorization: `Bearer ${s.token}` }
    })
  ).json()) as { url?: string; unavailable: boolean }
}

/** The live video plays from the Space's event playlist, whose fragments read. */
async function servedFromTheSpace(s: Started): Promise<void> {
  await until('playback from the Space', async () => {
    const found = await playback(s)
    return typeof found.url === 'string' && !found.unavailable
  })
  const url = (await playback(s)).url!
  expect(url, 'the live URL is the event playlist').contains('/hls/index.m3u8?')
  const body = await (await fetch(url)).text()
  const segment = body
    .split('\n')
    .find(line => line.startsWith('http') && line.includes('.m4s'))
  expect(segment, 'a published segment').not.equals(undefined)
  expect((await fetch(segment!)).ok, 'the published segment reads').equals(true)
}

/** Ends the camera, and checks the Space holds the closed fragment playlist. */
async function closedInTheSpace(s: Started): Promise<void> {
  const published = await untilBroadcast(
    s.media,
    s.show.id,
    'the broadcast to end',
    status => status.exit != null,
    { timeoutMs: 300_000 }
  )
  expect(published.exit, 'the broadcaster published').equals(0)
  expect(await endLiveStream(s.api, s.token, s.gameId, s.camera)).equals(200)
  await until(
    'the recording to be verified in the Space',
    async () =>
      (
        await s.control.sql(
          'SELECT spaces_verified_at FROM videos WHERE id = $1',
          [s.camera.videoId]
        )
      ).rows[0]?.spaces_verified_at != null,
    120_000,
    1000
  )
  const keys = (await s.media.objects(`videos/${s.camera.videoId}-`)).map(
    one => one.key
  )
  expect(keys.some(key => key.endsWith('/index.m3u8'))).equals(true)
  expect(
    keys.filter(key => key.endsWith('/video.mp4')),
    'no remux to one file'
  ).deep.equals([])
  // The Space's index.m3u8, as the API serves it from there.
  let url = (await playback(s)).url!
  let body = await (await fetch(url)).text()
  if (!body.includes('#EXTINF')) {
    const variant = body
      .split('\n')
      .find(line => line !== '' && !line.startsWith('#'))!
    url = new URL(variant, url).toString()
    body = await (await fetch(url)).text()
  }
  expect(body, 'the recording is the closed fragment playlist').contains(
    '#EXT-X-ENDLIST'
  )
}

async function contract(ctx: HarnessContext): Promise<void> {
  const s = await start(ctx, 75)
  await servedFromTheSpace(s)
  await closedInTheSpace(s)
}

interface Seen {
  method: string
  host: string
  path: string
  status: number
  range: string | undefined
}

async function chrome(ctx: HarnessContext): Promise<void> {
  const s = await start(ctx, 75)
  await servedFromTheSpace(s)
  const origin = ctx.stack.origin.replace(/\/+$/, '')
  const { m, page } = await ctx.browser(
    { width: 1280, height: 720 },
    { h264: true, observeNetwork: true }
  )
  const seen: Seen[] = []
  page.on('response', (response: HTTPResponse) => {
    const request = response.request()
    const url = new URL(request.url())
    seen.push({
      method: request.method(),
      host: url.host,
      path: url.pathname,
      status: response.status(),
      range: request.headers().range
    })
  })
  const viewerToken = await apiToken(s.api, s.viewer)
  await sessionOnBrowser(m, origin, viewerToken)
  await m.openLink({
    link: `${origin}/games/${s.gameId}?video=${s.camera.videoId}`
  })
  const read = async (script: string): Promise<string> => {
    await m.evalBrowserScript({ script, output: 'read' })
    return String((await m.vars()).read)
  }
  await until(
    'the live picture',
    async () =>
      (await read('return !!document.querySelector("video")?.videoWidth')) ===
      'true',
    60_000,
    200
  )
  if ((await read('return document.querySelector("video").paused')) === 'true')
    await m.tapOn({ id: 'gameVideoZones' })
  const film = ctx.artifact('live-chrome.mp4')
  await m.startRecording({ path: film })
  try {
    await m.takeScreenshot({ path: ctx.artifact('live-viewer-after.png') })
    const samples: Array<{ elapsed: number; position: number }> = []
    const began = Date.now()
    for (let i = 0; i < 7; i++) {
      if (i !== 0) await pause(5000)
      const position = Number(
        await read('return document.querySelector("video").currentTime')
      )
      expect(Number.isFinite(position), 'a playback position').equals(true)
      samples.push({ elapsed: (Date.now() - began) / 1000, position })
    }
    writeFileSync(
      ctx.artifact('device-pass.log'),
      `chrome\n${JSON.stringify(samples)}\n`
    )
    expect(
      samples.at(-1)!.position - samples[0].position,
      'Chrome played on for 25 seconds'
    ).at.least(25)
    await closedInTheSpace(s)
    await until(
      'the player to end',
      async () =>
        (await read('return !!document.querySelector("video")?.ended')) ===
        'true',
      120_000,
      1000
    )
    await m.takeScreenshot({ path: ctx.artifact('ended-chrome.png') })
  } finally {
    await m.stopRecording({ path: film })
  }

  const playlist = `/api/v1/videos/${s.camera.videoId}/hls/index.m3u8`
  const stackHost = new URL(origin).host
  const players = seen.filter(
    one =>
      one.host === stackHost &&
      one.method === 'GET' &&
      one.status === 200 &&
      one.path === playlist
  )
  expect(players.length, 'the player asked the API for the playlist').above(0)
  const reads = seen.filter(
    one =>
      one.host !== stackHost &&
      one.method === 'GET' &&
      one.range !== 'bytes=0-0' &&
      one.path.endsWith('.m4s') &&
      one.status >= 200 &&
      one.status < 300
  )
  expect(
    reads.length,
    'sustained media-fragment reads from the Space'
  ).at.least(3)
  const local = seen.filter(
    one => one.host === stackHost && one.path.startsWith('/media/')
  )
  expect(local, 'the player asked for ingest-local media').deep.equals([])
  writeFileSync(
    ctx.artifact('device-pass.log'),
    `${reads
      .map(one =>
        JSON.stringify({
          method: one.method,
          object: basename(one.path),
          status: one.status
        })
      )
      .join(
        '\n'
      )}\nPASS: live playback reached the recording end; ${reads.length} media-fragment reads from the Space; no /media/ requests; closed fragment recording kept without video.mp4.\n`,
    { flag: 'a' }
  )
}

export default defineHarness({
  id: 'playback/live-origin/space-playback',
  title:
    'A live stream plays from the Space’s event playlist, never the ingest’s own media, and closes as fragments',
  kind: 'e2e',
  covers: [
    'src/server/live/originPublish.ts',
    'src/server/live/originPublisher.ts',
    'src/server/live/finishVideo.ts',
    'src/server/media/spacesHls.ts',
    'src/server/routes/media.ts',
    'src/app/player/attachHls.ts'
  ],
  stack: 'isolated',
  fixtures: ['streaming'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // Chrome plays the live HEVC stream to its end.
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    contract,
    chrome,
    'viewer-node-holds-no-media': async () => {
      throw new BlockedError(
        'needs a second API node with a media root of its own beside the ingest’s, which a pool stack does not have: one stack runs one API, sharing the ingest’s media root'
      )
    },
    'outage-through-a-viewer-node': async () => {
      throw new BlockedError(
        'needs the outage run (playback/live-outage/viewers-ride-through) through a second API node with a media root of its own, which a pool stack does not have'
      )
    }
  }
})
