import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { decodeFirstFrame } from '../../../core/video'
import {
  endLiveStream,
  liveCamera,
  pause,
  sessionOnBrowser,
  until
} from '../../../rigs/media/liveCamera'
import {
  firstMarkers,
  parsePlaylist,
  type Segment,
  wallAtPosition
} from '../../../rigs/media/playlistClock'
import {
  markerGeometry,
  readMarkerSource,
  unwrapMarker
} from '../../../rigs/media/readMarker'
import { apiToken } from '../../../rigs/media/recordingSeek'
import {
  stackApi,
  stackControl,
  stackMedia,
  untilBroadcast
} from '../../../rigs/media/stackSpace'

/**
 * E20: live viewers ride through a publisher's outage. The stack's fake
 * broadcaster publishes 150 s into the stack's own ingest with a 20 s outage
 * at 60 s, with no sound, or with an AAC track (`with-sound`). With no sound
 * the recording gets a silent track and the return continues it with an
 * init segment of its own, under a new map; with sound the return shares the
 * recording's init segment, which goes over `init.mp4` under the map the
 * players hold. Three pages in this machine's Chrome:
 * - **A** watches live from the start and is never reloaded. It must pick
 *   the stream up again on its own soon after the publisher comes back.
 * - **B** opens a second after the publisher comes back, before the new
 *   writer has written anything: it holds the playlist across the respawn.
 * - **C** opens twenty seconds after, a fresh load with the break behind it.
 *
 * Every page logs each frame it presents: its own position and the wall
 * clock burned into the picture. A frame is in step when that clock is the
 * one the live playlist puts at that position (`playlistClock.ts`): the
 * ingest's own playlist, its segments read as a player reads them, through
 * the API's live playlist. After the stream is ended, C reloads the
 * recording and seeks either side of the break, judged against the same
 * playlist. maestro-d records page A across the break and C's seeks.
 */

/** The broadcaster's picture runs at 30 frames a second. */
const FRAME_MS = 1000 / 30
const DURATION_SEC = 150
const OUTAGE_AT_SEC = 60
const OUTAGE_SEC = 20
const RETURN_SEC = OUTAGE_AT_SEC + OUTAGE_SEC
/** "About ten seconds" from the publisher's return to pictures again. */
const RESUME_WITHIN_MS = 10_000
/** The share of frames after the break that must be in step. */
const IN_STEP_SHARE = 0.99
const SIZE = { width: 1280, height: 720 }

const iso = (ms: number): string => new Date(ms).toISOString()

/** Runs `script` in the page through maestro-d and answers what it returned. */
async function probe<T>(m: any, script: string): Promise<T> {
  await m.evalBrowserScript({
    script: `return JSON.stringify(await (async () => { ${script} })())`,
    output: 'probe'
  })
  return JSON.parse((await m.vars()).probe) as T
}

async function untilPage(
  m: any,
  script: string,
  what: string,
  ms = 90_000
): Promise<void> {
  await until(what, async () => await probe<boolean>(m, script), ms, 500)
}

const PICTURE_READY = `const v = document.querySelector('video'); return v != null && v.readyState >= 2 && v.videoWidth > 0`

/**
 * Logs every frame the page's player presents: the page's clock, the low
 * bits of the wall clock burned into the picture, and the frame's position.
 * The log lives on the window, so a page that reloaded has lost it.
 */
const FRAME_LOGGER = `
  const readMarker = ${readMarkerSource()}
  const geometry = ${JSON.stringify(markerGeometry(720))}
  const v = document.querySelector('video')
  window.__e20 = { frames: [], stop: false }
  const log = (now, meta) => {
    if (window.__e20.stop) return
    window.__e20.frames.push([Date.now(), readMarker(v, geometry), meta.mediaTime])
    v.requestVideoFrameCallback(log)
  }
  v.muted = true
  v.play().catch(() => undefined)
  v.requestVideoFrameCallback(log)
  return true
`

/** A camera's address carries its stream key: painted over for as long as the page lives. */
const HIDE_KEY = `const style = document.createElement('style')
  style.textContent = '[aria-label^="Copy the URL for"] { position: relative !important; background: #e8ebe2 !important } [aria-label^="Copy the URL for"] * { visibility: hidden !important } [aria-label^="Copy the URL for"]::after { content: "stream key hidden"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #555; font: 16px sans-serif }'
  document.head.appendChild(style)
  return true`

interface Frame {
  now: number
  wall: number | null
  mediaSec: number
}

async function frames(m: any, nearMs: number, label: string): Promise<Frame[]> {
  const raw = await probe<Array<[number, number | null, number]> | null>(
    m,
    `if (window.__e20 == null) return null; window.__e20.stop = true; return window.__e20.frames`
  )
  if (raw == null) throw new Error(`${label}: the page lost its frame log`)
  return raw.map(([now, low, mediaSec]) => ({
    now,
    wall: low == null ? null : unwrapMarker(low, nearMs),
    mediaSec
  }))
}

/**
 * The frames whose picture is not the one the playlist puts at their
 * position, out of those whose marker could be read.
 */
function judge(
  log: Frame[],
  segments: readonly Segment[],
  markers: ReadonlyArray<number | null>
): { read: number; wrong: Array<Frame & { expected: number | null }> } {
  const read = log.filter(frame => frame.wall != null)
  const wrong = []
  for (const frame of read) {
    const expected = wallAtPosition(segments, markers, frame.mediaSec)
    if (expected != null && Math.abs(frame.wall! - expected) <= FRAME_MS)
      continue
    wrong.push({ ...frame, expected })
  }
  return { read: read.length, wrong }
}

/** The live playlist the API serves, its segments' and init's signed URLs by name. */
async function servedPieces(
  api: string,
  token: string,
  videoId: string
): Promise<Map<string, string>> {
  const playback = (await (
    await fetch(`${api}/videos/${videoId}/playback`, {
      headers: { authorization: `Bearer ${token}` }
    })
  ).json()) as { url?: string }
  if (playback.url == null) throw new Error('the live video has no playback')
  let from = playback.url
  let text = await (await fetch(from)).text()
  if (!text.includes('#EXTINF')) {
    const variant = text
      .split('\n')
      .find(line => line !== '' && !line.startsWith('#'))!
    from = new URL(variant, from).toString()
    text = await (await fetch(from)).text()
  }
  const urls = new Map<string, string>()
  for (const line of text.split('\n')) {
    const map = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line)?.[1]
    const uri = map ?? (line !== '' && !line.startsWith('#') ? line : null)
    if (uri == null) continue
    const url = new URL(uri, from)
    urls.set(basename(url.pathname), url.toString())
  }
  return urls
}

async function read(urls: Map<string, string>, name: string): Promise<Buffer> {
  const url = urls.get(name)
  if (url == null) throw new Error(`the live playlist serves no ${name}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${name}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function rideThrough(ctx: HarnessContext, sound: boolean): Promise<void> {
  const control = stackControl(ctx)
  const media = stackMedia(control)
  const api = stackApi(ctx)
  const origin = ctx.stack.origin.replace(/\/+$/, '')
  const world = await ctx.fixture('streaming')
  const gameId = world.ids.game
  const token = await apiToken(api, world.accounts.coach)
  const failures: string[] = []
  const lines: string[] = []
  const say = (line: string): void => {
    lines.push(line)
  }
  const check = (ok: boolean, what: string): void => {
    say(`${ok ? 'PASS' : 'FAIL'} ${what}`)
    if (!ok) failures.push(what)
  }

  const angle = await liveCamera(api, token, gameId, 'E20 outage')
  const show = await media.broadcast({
    url: angle.url,
    script: 'outage',
    duration: DURATION_SEC,
    outages: [{ at: OUTAGE_AT_SEC, seconds: OUTAGE_SEC }],
    sound
  })
  const t0 = show.t0
  say(`T0 ${iso(t0)}`)
  const at = async (sec: number): Promise<void> => {
    await pause(t0 + sec * 1000 - Date.now())
  }
  const watch = `${origin}/games/${gameId}?video=${angle.videoId}`
  const open = async (): Promise<any> => {
    const { m } = await ctx.browser(SIZE, { h264: true })
    await sessionOnBrowser(m, origin, token)
    return m
  }
  const pages = { A: await open(), B: await open(), C: await open() }

  await at(8)
  await pages.A.openLink({ link: watch })
  await untilPage(pages.A, PICTURE_READY, 'page A showed the live picture')
  await probe(pages.A, HIDE_KEY)
  await probe(pages.A, FRAME_LOGGER)
  say('A: watching live, logging every frame')
  const filmA = ctx.artifact('live-outage-viewer.mp4')
  const filming = (async () => {
    await at(OUTAGE_AT_SEC - 10)
    await pages.A.startRecording({ path: filmA })
    await at(RETURN_SEC + 25)
    await pages.A.stopRecording({ path: filmA })
  })()

  await at(RETURN_SEC + 1)
  await pages.B.openLink({ link: watch })
  await untilPage(pages.B, PICTURE_READY, 'page B showed a picture')
  await probe(pages.B, FRAME_LOGGER)
  say('B: opened just after the publisher came back')

  await at(RETURN_SEC + 20)
  await pages.C.openLink({ link: watch })
  await untilPage(pages.C, PICTURE_READY, 'page C showed a picture')
  await probe(pages.C, FRAME_LOGGER)
  say('C: opened fresh after the break')

  const published = await untilBroadcast(
    media,
    show.id,
    'the broadcast to end',
    status => status.exit != null,
    { timeoutMs: (DURATION_SEC + 120) * 1000 }
  )
  check(published.exit === 0, 'the broadcaster published every part')
  await filming
  // The viewers are some seconds behind the publisher.
  await pause(20_000)
  const back = published.events.find(
    event => event.event === 'publish' && event.fromSec === RETURN_SEC
  )?.at
  if (back == null) throw new Error('the broadcaster never came back')
  say(`the publisher came back ${iso(back)}`)

  const live = await media.ingestFiles(angle.videoId)
  const livePlaylist = live.master
  const { segments, mediaSequence, ended } = parsePlaylist(livePlaylist)
  // With a Space, the ingest keeps only the newest pieces on disk; every
  // piece is read as a player reads it, through the API's live playlist.
  const urls = await servedPieces(api, token, angle.videoId)
  const markers = await firstMarkers({
    segments,
    nearMs: t0,
    init: await read(urls, 'init.mp4'),
    read: async uri => await read(urls, basename(uri)),
    decode: async file => await decodeFirstFrame(file, { pixFmt: 'gray' }),
    scratch: ctx.runDir
  })
  const maps = livePlaylist
    .split('\n')
    .filter(line => line.startsWith('#EXT-X-MAP:'))
  const discontinuities = segments.filter(one => one.discontinuity).length
  say(
    `the live playlist ${JSON.stringify({ mediaSequence, ended, segments: segments.length, discontinuities, maps, firstNumbers: segments.slice(0, 3).map(one => one.uri) })}`
  )
  if (sound) {
    // A return with the recording's own configuration shares its init
    // segment: under the map the pages hold, with no other.
    check(
      maps.length === 1 && maps[0] === '#EXT-X-MAP:URI="init.mp4"',
      `the return shares init.mp4: one map (${maps.join(' ')})`
    )
    check(discontinuities === 1, `one join (${discontinuities})`)
    check(
      !live.names.includes('.writer-init.mp4'),
      "the returning writer's init segment went over init.mp4"
    )
  }
  check(
    markers.every(one => one != null),
    `every segment's first frame was read (${markers.filter(one => one != null).length} of ${markers.length})`
  )
  check(
    segments.every(
      (one, i) =>
        one.uri === `seg${String(mediaSequence + i).padStart(6, '0')}.m4s`
    ),
    'every segment is named for its media sequence number'
  )
  check(
    segments.every(one => one.programDateTime != null),
    'every segment carries EXT-X-PROGRAM-DATE-TIME'
  )

  for (const name of ['A', 'B', 'C'] as const) {
    const log = await frames(pages[name], t0, `page-${name}`)
    const afterBreak = log.filter(
      frame => frame.wall != null && frame.wall >= t0 + RETURN_SEC * 1000 - 1000
    )
    const judged = judge(afterBreak, segments, markers)
    const share = judged.read === 0 ? 0 : 1 - judged.wrong.length / judged.read
    for (const frame of judged.wrong.slice(0, 5)) {
      say(
        `${name}: out of step ${JSON.stringify({ now: iso(frame.now), picture: iso(frame.wall!), positionSec: frame.mediaSec, playlistPuts: frame.expected == null ? null : iso(frame.expected) })}`
      )
    }
    check(
      judged.read > 300 && share >= IN_STEP_SHARE,
      `${name}: ${judged.read - judged.wrong.length} of ${judged.read} frames after the break in step (${(share * 100).toFixed(2)}%)`
    )
    if (name !== 'A') continue
    const lastBefore = log.filter(
      frame => frame.wall != null && frame.wall < t0 + OUTAGE_AT_SEC * 1000
    )
    const firstAfter = afterBreak[0]
    const stalledAt = lastBefore[lastBefore.length - 1]?.now
    check(
      firstAfter != null && firstAfter.now - back <= RESUME_WITHIN_MS,
      `A picked the stream up again ${firstAfter == null ? 'never' : `${((firstAfter.now - back) / 1000).toFixed(1)} s after the publisher came back`} (its last picture before the break was at ${stalledAt == null ? '-' : iso(stalledAt)}), without a reload`
    )
  }

  // The end: the recording, at moments either side of the break.
  expect(await endLiveStream(api, token, gameId, angle)).equals(200)
  await until(
    'the recording to be packed up',
    async () => {
      const row = (
        await control.sql('SELECT status, width FROM videos WHERE id = $1', [
          angle.videoId
        ])
      ).rows[0]
      return row?.status === 'ready' && row.width != null
    },
    180_000,
    500
  )
  say('recorded')
  await pages.C.openLink({ link: watch })
  await untilPage(pages.C, PICTURE_READY, 'page C showed the recording')
  const total =
    segments[segments.length - 1].startSec +
    segments[segments.length - 1].durationSec
  const seeks = [
    10,
    35,
    OUTAGE_AT_SEC - 3,
    OUTAGE_AT_SEC + 2,
    OUTAGE_AT_SEC + 20,
    total - 10
  ]
  const filmC = ctx.artifact('recording-seek.mp4')
  await pages.C.startRecording({ path: filmC })
  let inStep = 0
  try {
    for (const atSec of seeks) {
      const seen = await probe<{
        low: number | null
        frameSec: number | null
      }>(
        pages.C,
        `
        const readMarker = ${readMarkerSource()}
        const v = document.querySelector('video')
        v.pause()
        await new Promise(resolve => {
          const late = setTimeout(resolve, 5000)
          v.addEventListener('seeked', () => { clearTimeout(late); resolve() }, { once: true })
          v.currentTime = ${atSec}
        })
        const frameSec = await new Promise(resolve => {
          const late = setTimeout(() => resolve(null), 3000)
          v.requestVideoFrameCallback((now, meta) => { clearTimeout(late); resolve(meta.mediaTime) })
        })
        return { low: readMarker(v, ${JSON.stringify(markerGeometry(720))}), frameSec: frameSec ?? v.currentTime }
      `
      )
      const picture = seen.low == null ? null : unwrapMarker(seen.low, t0)
      const expected =
        seen.frameSec == null
          ? null
          : wallAtPosition(segments, markers, seen.frameSec)
      const ok =
        picture != null &&
        expected != null &&
        Math.abs(picture - expected) <= FRAME_MS
      if (ok) inStep++
      say(
        `seek ${atSec.toFixed(1)} s  frame ${seen.frameSec?.toFixed(3) ?? '-'}  picture ${picture == null ? '-' : iso(picture)}  playlist ${expected == null ? '-' : iso(expected)}  ${ok ? 'in step' : 'OUT'}`
      )
    }
  } finally {
    await pages.C.stopRecording({ path: filmC })
  }
  check(
    inStep === seeks.length,
    `the recording is in step at ${inStep} of ${seeks.length} seeks`
  )
  writeFileSync(ctx.artifact('live-outage.log'), `${lines.join('\n')}\n`)
  expect(failures).deep.equals([])
}

export default defineHarness({
  id: 'playback/live-outage/viewers-ride-through',
  title:
    'Live viewers pick the stream up again, in step, after a publisher outage, and so does a fresh page',
  kind: 'e2e',
  covers: [
    'src/app/player/attachHls.ts',
    'src/app/player/explicitSeek.ts',
    'src/server/live/controller.ts',
    'src/server/live/splitter.ts',
    'src/server/live/segmentClock.ts',
    'src/server/live/originPublish.ts',
    'src/server/live/finishVideo.ts'
  ],
  stack: 'isolated',
  fixtures: ['streaming'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // Three pages play the live HEVC stream and its recording.
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 12,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'without-sound': async ctx => {
      await rideThrough(ctx, false)
    },
    'with-sound': async ctx => {
      await rideThrough(ctx, true)
    }
  }
})
