import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import type { WallAnchor } from '../../../../src/common/wallTimeline'
import { wallAt } from '../../../../src/common/wallTimeline'
import { parseMediaPlaylist } from '../../../../src/server/media/wallClockScan'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  markerGeometry,
  readMarkerSource,
  unwrapMarker
} from '../../../rigs/media/readMarker'
import {
  ask,
  boardBrowser,
  type BoardStack,
  boardStack,
  broadcast,
  type Camera,
  camera,
  clock,
  FRAME_MS,
  iso,
  pause,
  PICTURE_READY,
  probe,
  until
} from '../../../rigs/overlayRig'

/**
 * E5: frame-exact wall-clock timelines from the frames' own SEI, live and
 * recorded, across a publisher's outage; and segment arrival for a
 * publisher that carries none. The stack's own ingest, FFmpeg and fake
 * broadcaster (stamping the SEI there), and this machine's Chrome, through
 * maestro-d, reading the marker burned into the frame on screen.
 */

const STAMPED = { duration: 180, outageAt: 60, outageSec: 20 }
const PLAIN = { duration: 60, outageAt: 20, outageSec: 20 }

interface Timeline {
  live: boolean
  source: string
  confidence: string
  anchors: WallAnchor[]
}

/** What the scenario printed, kept as its proof. */
function proof(ctx: HarnessContext): {
  say: (line: string) => void
  check: (ok: boolean, what: string) => void
  done: (name: string) => void
} {
  const lines: string[] = []
  const failures: string[] = []
  const say = (line: string): void => {
    console.log(line)
    lines.push(line)
  }
  return {
    say,
    check: (ok, what) => {
      say(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
      if (!ok) failures.push(what)
    },
    done: name => {
      writeFileSync(ctx.artifact(name), `${lines.join('\n')}\n`)
      expect(failures, failures.join('\n')).deep.equals([])
    }
  }
}

/** Where a timeline leaves 1×: each pair of points the wall moves `beyondMs` past. */
function turns(
  anchors: WallAnchor[],
  beyondMs = 20
): Array<{ from: WallAnchor; to: WallAnchor; jumpMs: number }> {
  const out = []
  for (let i = 1; i < anchors.length; i++) {
    const [m0, w0] = anchors[i - 1]
    const [m1, w1] = anchors[i]
    const jumpMs = w1 - w0 - (m1 - m0)
    if (Math.abs(jumpMs) > beyondMs)
      out.push({ from: anchors[i - 1], to: anchors[i], jumpMs })
  }
  return out
}

/** A video's wall timeline, as the app asks for it, summed up in the proof. */
async function timelineOf(
  stack: BoardStack,
  videoId: string,
  say: (line: string) => void
): Promise<{ status: number; json: Timeline }> {
  say(`$ GET /videos/${videoId}/wall-timeline`)
  const got = await ask(stack, `/videos/${videoId}/wall-timeline`)
  const json = got.json as Timeline
  const { anchors, ...rest } = json
  say(`  ${got.status} ${JSON.stringify({ ...rest, points: anchors.length })}`)
  if (anchors.length > 0) {
    const [m0, w0] = anchors[0]
    const [m1, w1] = anchors.at(-1)!
    say(`    first [${m0}, ${w0}] ${iso(w0)}   last [${m1}, ${w1}] ${iso(w1)}`)
  }
  for (const turn of turns(anchors))
    say(
      `    turn  [${turn.from.join(', ')}] -> [${turn.to.join(', ')}]  wall moves ${turn.jumpMs} ms more than media`
    )
  return { status: got.status, json }
}

/** Ends a camera and waits for its recording to be packed up and rescanned. */
async function finish(
  ctx: HarnessContext,
  stack: BoardStack,
  held: Camera,
  check: (ok: boolean, what: string) => void,
  say: (line: string) => void
): Promise<void> {
  say(`$ POST /games/${held.gameId}/live-streams/${held.streamId}/end`)
  const ended = await ask(
    stack,
    `/games/${held.gameId}/live-streams/${held.streamId}/end`,
    { method: 'POST' }
  )
  check(ended.status === 200, 'the camera is ended')
  for (let tries = 0; tries < 240; tries++) {
    const row = (
      await ctx.stack.control!.sql(
        'select status, width, duration_sec from videos where id = $1',
        [held.videoId]
      )
    ).rows[0]
    if (row?.status === 'ready' && row.width != null) {
      say(`recording packed up ${JSON.stringify(row)}`)
      return
    }
    await pause(500)
  }
  throw new Error(`${held.videoId} was never packed up`)
}

/**
 * A recording's total `EXTINF`, in seconds, read as a player reads it: from
 * the address `/playback` hands out.
 */
async function recordingSeconds(
  stack: BoardStack,
  videoId: string
): Promise<number> {
  const playback = await ask(stack, `/videos/${videoId}/playback`)
  const address = (playback.json as { url?: string } | null)?.url
  if (address == null) throw new Error(`${videoId} has no playback address`)
  let url = new URL(address)
  let text = await (await fetch(url)).text()
  // A master playlist names its one variant on the line after its stream.
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = text
      .split('\n')
      .find(line => line !== '' && !line.startsWith('#'))!
    url = new URL(variant, url)
    text = await (await fetch(url)).text()
  }
  return parseMediaPlaylist(text).segments.reduce(
    (sum, segment) => sum + segment.durationSec,
    0
  )
}

interface Read {
  position: number
  mediaTime: number
  currentTime: number
  marker: number | null
}

/**
 * Chrome plays a recording in the web app and reads the marker burned into
 * the frame on screen at each position, with the presented frame's own time
 * (`requestVideoFrameCallback`).
 */
async function markersOnScreen(
  ctx: HarnessContext,
  stack: BoardStack,
  held: Camera,
  positions: number[]
): Promise<Read[]> {
  const { m } = await boardBrowser(ctx, stack, '1280x720')
  await m.openLink({
    link: `${stack.origin}/games/${held.gameId}?video=${held.videoId}`
  })
  // The recording has loaded far enough to show a picture.
  await until(m, PICTURE_READY, `${held.videoId} showed a picture`, 60_000)
  const reads: Read[] = []
  for (const position of positions) {
    const read = await probe<Omit<Read, 'position'>>(
      m,
      `
      const readMarker = ${readMarkerSource()}
      const v = document.querySelector('video')
      v.pause()
      await new Promise(resolve => {
        v.addEventListener('seeked', resolve, { once: true })
        v.currentTime = ${position}
      })
      // The frame now on screen, and its own time: the one a seek lands on
      // is the last that presents at or before it.
      const mediaTime = await new Promise(resolve => {
        const late = setTimeout(() => resolve(null), 3000)
        v.requestVideoFrameCallback((now, frame) => {
          clearTimeout(late)
          resolve(frame.mediaTime)
        })
      })
      // A frame of slack for the compositor to have it, then read it.
      await new Promise(resolve => setTimeout(resolve, 100))
      return {
        mediaTime: mediaTime ?? v.currentTime,
        currentTime: v.currentTime,
        marker: readMarker(v, ${JSON.stringify(markerGeometry(720))})
      }
    `
    )
    reads.push({ position, ...read })
  }
  return reads
}

/** Deletes the video and its camera, and checks the ingest's disk no longer holds it. */
async function cleanUp(
  stack: BoardStack,
  held: Camera,
  check: (ok: boolean, what: string) => void,
  say: (line: string) => void
): Promise<void> {
  say(`$ DELETE /videos/${held.videoId}`)
  const gone = await ask(stack, `/videos/${held.videoId}`, {
    method: 'DELETE'
  })
  say(`  ${gone.status}`)
  say(`$ DELETE /games/${held.gameId}/live-streams/${held.streamId}`)
  await ask(stack, `/games/${held.gameId}/live-streams/${held.streamId}`, {
    method: 'DELETE'
  })
  const left = await stack.media.ingestFiles(held.videoId)
  check(
    left.names.length === 0,
    `${held.videoId}'s media is gone (${left.names.length} files left)`
  )
}

/** /time answers the server's clock. */
async function serverClock(
  stack: BoardStack,
  check: (ok: boolean, what: string) => void,
  say: (line: string) => void
): Promise<void> {
  say('$ GET /time')
  const clockNow = (await ask(stack, '/time')).json as { now: number }
  check(
    Math.abs(clockNow.now - Date.now()) < 5000,
    `/time answers the server's clock (${clockNow.now - Date.now()} ms from this machine's)`
  )
}

/** 1–3 and 5: a stamped stream, live and recorded, and its markers on screen. */
async function stamped(ctx: HarnessContext): Promise<void> {
  const { say, check, done } = proof(ctx)
  const { stack, games } = await boardStack(ctx)
  const [gameId] = games
  await serverClock(stack, check, say)
  const { duration, outageAt, outageSec } = STAMPED
  say(
    `\n# A stamped stream: ${duration} s, ${outageSec} s outage at ${outageAt} s`
  )
  const held = await camera(stack, gameId, 'E5 stamped')
  // With sound, as a phone publishes: each part's recording starts at once,
  // so media 0 is T0 and an outage is its own length.
  const show = await broadcast(stack, held, {
    stamped: true,
    sound: true,
    duration,
    outages: [{ at: outageAt, seconds: outageSec }]
  })
  const t0 = show.t0
  say(`T0 ${t0} ${iso(t0)}`)
  const at = clock(t0)
  await at(outageAt * 0.75)
  const beforeOutage = await timelineOf(stack, held.videoId, say)
  await at(outageAt + outageSec + 30)
  const afterOutage = await timelineOf(stack, held.videoId, say)
  const code = await show.done()
  check(code === 0, `the broadcaster published every part (exit ${code})`)
  for (const [label, timeline] of [
    ['before the outage', beforeOutage],
    ['after the outage', afterOutage]
  ] as const) {
    check(
      timeline.status === 200 &&
        timeline.json.live &&
        timeline.json.source === 'sei' &&
        timeline.json.confidence === 'frame',
      `live, ${label}: live ${timeline.json.live}, source ${timeline.json.source}, confidence ${timeline.json.confidence}`
    )
    check(
      timeline.json.anchors[0][1] === t0,
      `live, ${label}: media 0 is T0 (${timeline.json.anchors[0][1] - t0} ms)`
    )
  }
  check(
    turns(beforeOutage.json.anchors).length === 0,
    'live, before the outage: one straight line, a point every half second'
  )
  const liveTurns = turns(afterOutage.json.anchors)
  check(
    liveTurns.length === 1 &&
      Math.abs(liveTurns[0].jumpMs - outageSec * 1000) <= 2 * FRAME_MS,
    `live, after the outage: one jump of ${liveTurns[0]?.jumpMs} ms at media ${liveTurns[0]?.to[0]} (the outage is ${outageSec * 1000} ms)`
  )
  await finish(ctx, stack, held, check, say)
  const vod = await timelineOf(stack, held.videoId, say)
  check(
    !vod.json.live &&
      vod.json.source === 'sei' &&
      vod.json.confidence === 'frame',
    `recorded: live ${vod.json.live}, source ${vod.json.source}, confidence ${vod.json.confidence}`
  )
  const vodTurns = turns(vod.json.anchors)
  check(
    vodTurns.length === 1 &&
      Math.abs(vodTurns[0].jumpMs - outageSec * 1000) <= 2 * FRAME_MS,
    `recorded: one jump of ${vodTurns[0]?.jumpMs} ms at media ${vodTurns[0]?.to[0]}`
  )
  const liveBefore = beforeOutage.json.anchors
  check(
    JSON.stringify(vod.json.anchors.slice(0, liveBefore.length)) ===
      JSON.stringify(liveBefore),
    `recorded: the ${liveBefore.length} points before the outage are the live ones`
  )
  const anchorRows = await ctx.stack.control!.sql(
    `select count(*)::int as n, bool_and(source = 'sei') as sei, bool_and(corrected) as corrected from video_wall_anchors where video_id = $1`,
    [held.videoId]
  )
  say(`video_wall_anchors ${JSON.stringify(anchorRows.rows[0])}`)

  say('\n# The marker on screen, in Chrome')
  const playedSec = duration - outageSec
  // Four before the outage, one just after it, and five more on to the end.
  const step = (playedSec - 3 - (outageAt + 1)) / 5
  const positions = [
    2.3,
    outageAt * 0.3,
    outageAt * 0.6,
    outageAt - 1.7,
    outageAt + 0.3,
    ...[1, 2, 3, 4, 5].map(n => outageAt + 1 + n * step)
  ].map(one => Math.round(one * 10) / 10)
  const reads = await markersOnScreen(ctx, stack, held, positions)
  say(
    '  stamped: position  frame time  marker wall               wallAt(frame time)        marker - wallAt'
  )
  for (const read of reads) {
    const expected = wallAt(vod.json.anchors, read.mediaTime * 1000)!
    const marker =
      read.marker == null ? null : unwrapMarker(read.marker, expected)
    const off = marker == null ? null : marker - expected
    say(
      `           ${String(read.position).padStart(6)}  ${read.mediaTime.toFixed(3).padStart(9)}  ${marker == null ? 'unread'.padEnd(24) : iso(marker)}  ${iso(expected)}  ${off == null ? '-' : `${off.toFixed(1)} ms`}`
    )
    check(
      off != null && Math.abs(off) <= FRAME_MS,
      `stamped at ${read.position} s: the marker is wallAt(frame time) within one frame`
    )
  }
  check(
    reads.length === positions.length,
    `${reads.length} of ${positions.length} positions read`
  )
  check(
    reads.some(read => read.mediaTime > outageAt),
    'positions after the outage were read'
  )
  await cleanUp(stack, held, check, say)
  done('sei-timelines-stamped.log')
}

/** 4 and 5: an unstamped stream, its arrival points live and recorded, and its markers on screen. */
async function unstamped(ctx: HarnessContext): Promise<void> {
  const { say, check, done } = proof(ctx)
  const { stack, games } = await boardStack(ctx)
  const [gameId] = games
  await serverClock(stack, check, say)
  const { duration, outageAt, outageSec } = PLAIN
  say(
    `\n# An unstamped stream: ${duration} s, ${outageSec} s outage at ${outageAt} s`
  )
  const held = await camera(stack, gameId, 'E5 unstamped')
  const show = await broadcast(stack, held, {
    sound: true,
    duration,
    outages: [{ at: outageAt, seconds: outageSec }]
  })
  const t0 = show.t0
  await clock(t0)(duration + 3)
  const plainLive = await timelineOf(stack, held.videoId, say)
  const code = await show.done()
  check(code === 0, `the broadcaster published every part (exit ${code})`)
  const arrivals = plainLive.json.anchors
  check(
    plainLive.json.live &&
      plainLive.json.source === 'arrival' &&
      plainLive.json.confidence === 'approximate',
    `live: source ${plainLive.json.source}, confidence ${plainLive.json.confidence}, ${arrivals.length} points`
  )
  const segmentStarts = arrivals.map(([mediaMs]) => mediaMs)
  check(
    segmentStarts.every(
      (mediaMs, i) => i === 0 || mediaMs > segmentStarts[i - 1]
    ) && arrivals.length >= 8,
    `live: one point a segment, at ${segmentStarts.join(', ')} ms`
  )
  const plainTurns = turns(arrivals, 1500)
  check(
    plainTurns.length === 1 &&
      Math.abs(plainTurns[0].jumpMs - outageSec * 1000) <= 2000,
    `live: the outage is in the points, a jump of ${plainTurns[0]?.jumpMs} ms at media ${plainTurns[0]?.to[0]}`
  )
  say(
    `each point late by (arrival less the marker it starts with) ${JSON.stringify(
      arrivals.map(([mediaMs, wallMs]) => {
        // Before the outage media time is the picture's own; after it the
        // picture is `outage` further on.
        const pictureMs =
          mediaMs < outageAt * 1000 ? mediaMs : mediaMs + outageSec * 1000
        return wallMs - (t0 + pictureMs)
      })
    )}`
  )
  // A live playlist's total `EXTINF`, from the ingest's disk: `master.m3u8`
  // is the live one until the recording replaces it.
  const liveSec = parseMediaPlaylist(
    (await stack.media.ingestFiles(held.videoId)).master
  ).segments.reduce((sum, segment) => sum + segment.durationSec, 0)
  await finish(ctx, stack, held, check, say)
  const plainVod = await timelineOf(stack, held.videoId, say)
  check(
    !plainVod.json.live && plainVod.json.source === 'arrival',
    `recorded: live ${plainVod.json.live}, source ${plainVod.json.source}, ${plainVod.json.anchors.length} points`
  )
  check(
    JSON.stringify(plainVod.json.anchors.slice(0, arrivals.length)) ===
      JSON.stringify(arrivals),
    'recorded: the live points carried over unchanged'
  )
  // The points sit at the live segments' starts, and the recording is those
  // segments end to end. Each live writer's last segment, the one before a
  // reconnect and the one at the end, is listed about a frame short, and the
  // remux counts it whole: so the recording may run a frame longer per
  // writer, and the points after a reconnect sit that much early in it.
  const writers = 2
  const recordingSec = await recordingSeconds(stack, held.videoId)
  check(
    Math.abs(recordingSec - liveSec) * 1000 <= writers * (FRAME_MS + 10),
    `the recording is the live segments end to end, to a frame a writer: ${recordingSec.toFixed(3)} s and ${liveSec.toFixed(3)} s`
  )

  say('\n# The marker on screen, in Chrome')
  const reads = await markersOnScreen(ctx, stack, held, [5, 15, 25, 35])
  say(
    '  unstamped: position  frame time  marker wall               wallAt(frame time)        wallAt - marker'
  )
  const lateness: Array<{ position: number; late: number | null }> = []
  for (const read of reads) {
    const expected = wallAt(plainVod.json.anchors, read.mediaTime * 1000)!
    const marker =
      read.marker == null ? null : unwrapMarker(read.marker, expected)
    const late = marker == null ? null : expected - marker
    lateness.push({ position: read.position, late })
    say(
      `             ${String(read.position).padStart(6)}  ${read.mediaTime.toFixed(3).padStart(9)}  ${marker == null ? 'unread'.padEnd(24) : iso(marker)}  ${iso(expected)}  ${late == null ? '-' : `${late.toFixed(0)} ms`}`
    )
    check(
      late != null && late > -1500 && late < 5000,
      `unstamped at ${read.position} s: late by the publish latency at most (${late} ms)`
    )
  }
  const beforeLate = lateness
    .filter(one => one.position < outageAt)
    .map(one => one.late!)
  const afterLate = lateness
    .filter(one => one.position >= outageAt)
    .map(one => one.late!)
  check(
    beforeLate.length > 0 &&
      afterLate.length > 0 &&
      Math.abs(Math.max(...afterLate) - Math.min(...beforeLate)) < 2000,
    'unstamped: as late after the outage as before it'
  )
  await cleanUp(stack, held, check, say)
  done('sei-timelines-unstamped.log')
}

export default defineHarness({
  id: 'playback/wall-clock/sei-timelines',
  title:
    'Wall-clock timelines are frame-exact from a stamped stream’s SEI, and arrival points for one with none, live and recorded, across an outage',
  kind: 'e2e',
  covers: [
    'src/server/media/wallClockScan.ts',
    'src/common/wallTimeline.ts',
    'src/server/live/**',
    'scripts/stampWallClockSei.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoring-game'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // It plays the stack's HEVC recordings.
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
  scenarios: { stamped, unstamped }
})
