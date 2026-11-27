import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  markerGeometry,
  readMarkerSource,
  unwrapMarker
} from '../../../rigs/media/readMarker'
import { untilBroadcast } from '../../../rigs/media/stackSpace'
import {
  camera,
  endCamera,
  GRID_VIDEOS,
  gridPath,
  liveGame,
  open,
  pause,
  playerWeb,
  type PlayerWorld,
  playerWorld,
  removeCamera,
  videoReadings
} from '../player-layouts/games'

/**
 * What the live multi-angle work is judged by: each live angle's media
 * playlist, the live writer at a camera's timestamp jump (E5) and at a
 * stalled uplink, and All Angles' tiles read once a second. Each prints its
 * `$`-lines and what came back into `probe.log` in the run directory, and
 * holds what the writer promises (`src/server/live/timestampJump.ts`): a gap
 * in a publish ends the writer and a new one continues the playlist behind a
 * discontinuity, so no segment is longer than the live segments and
 * `#EXT-X-TARGETDURATION` is never raised to the gap's length.
 */

/**
 * The live segment length the stack writes: its `live.segmentSeconds`, or
 * where it sets none the server's own default, read from its config schema.
 */
async function segmentSeconds(pw: PlayerWorld): Promise<number> {
  const { live } = await pw.media.ingestFiles('none')
  if (typeof live.segmentSeconds === 'number') return live.segmentSeconds
  const { asServerConfig } =
    await import('../../../../src/server/serverConfigSchema')
  return asServerConfig({}).live.segmentSeconds
}

interface PlaylistFacts {
  target: number | null
  segments: number
  longest: number
  discontinuities: number
  dates: number
}

class Probe {
  readonly lines: string[] = []
  constructor(private readonly ctx: HarnessContext) {}
  dollar(line: string): void {
    this.lines.push(`$ ${line}`)
  }

  say(line: string): void {
    this.lines.push(line)
  }

  keep(): void {
    writeFileSync(this.ctx.artifact('probe.log'), `${this.lines.join('\n')}\n`)
  }

  /** A playlist and what matters in it. */
  async playlist(name: string, url: string): Promise<PlaylistFacts> {
    this.dollar(`curl -s '<${name} playlist>'`)
    const text = await (await fetch(url)).text()
    const lines = text.split('\n')
    const target = lines.find(line => line.startsWith('#EXT-X-TARGETDURATION'))
    const discontinuities = lines.filter(
      line => line === '#EXT-X-DISCONTINUITY'
    ).length
    const lengths = lines
      .filter(line => line.startsWith('#EXTINF:'))
      .map(line => Number(line.slice(8).split(',')[0]))
    const dates = lines.filter(line =>
      line.startsWith('#EXT-X-PROGRAM-DATE-TIME')
    )
    const holdBack = lines.some(line => line.includes('HOLD-BACK'))
    this.say(
      [
        target ?? '#EXT-X-TARGETDURATION missing',
        `segments: ${lengths.length}, longest ${Math.max(0, ...lengths).toFixed(3)} s`,
        `#EXT-X-DISCONTINUITY: ${discontinuities}`,
        `#EXT-X-PROGRAM-DATE-TIME: ${dates.length} (first ${dates[0]?.slice(25) ?? '-'}, last ${dates.at(-1)?.slice(25) ?? '-'})`,
        `HOLD-BACK declared: ${holdBack ? 'yes' : 'no'}`
      ].join('\n')
    )
    // The lines either side of each discontinuity, as the playlist has them.
    lines.forEach((line, index) => {
      if (line !== '#EXT-X-DISCONTINUITY') return
      this.say(lines.slice(Math.max(0, index - 3), index + 4).join('\n'))
    })
    return {
      target: target == null ? null : Number(target.split(':')[1]),
      segments: lengths.length,
      longest: Math.max(0, ...lengths),
      discontinuities,
      dates: dates.length
    }
  }
}

/** No segment longer than the live segments, and the target not raised. */
function heldToSegments(
  facts: PlaylistFacts,
  seconds: number,
  what: string
): void {
  expect(facts.target, `${what}: #EXT-X-TARGETDURATION`).not.equals(null)
  expect(facts.segments, `${what}: segments`).greaterThan(0)
  expect(facts.target!, `${what}: target duration`).at.most(
    Math.ceil(seconds) + 1
  )
  expect(facts.longest, `${what}: longest segment`).at.most(facts.target!)
}

async function playlists(ctx: HarnessContext): Promise<void> {
  const probe = new Probe(ctx)
  const pw = await playerWorld(ctx)
  const seconds = await segmentSeconds(pw)
  const V = await liveGame(pw)
  try {
    for (const [index, videoId] of V.videos.entries()) {
      const playback = await pw.client.playback(videoId)
      if (playback.url == null) throw new Error(`${videoId} has no address`)
      const facts = await probe.playlist(`V angle ${index + 1}`, playback.url)
      heldToSegments(facts, seconds, `angle ${index + 1}`)
      expect(facts.dates, `angle ${index + 1}: program date-times`).greaterThan(
        0
      )
    }
  } finally {
    probe.keep()
    await V.stop()
  }
}

/** A camera of its own on V, published for 90 s with one jump or stall at 40 s. */
function publishOnce(kind: 'jump' | 'stall', gap: number) {
  return async (ctx: HarnessContext): Promise<void> => {
    const probe = new Probe(ctx)
    const pw = await playerWorld(ctx)
    const seconds = await segmentSeconds(pw)
    const V = pw.world.ids.V
    const one = await camera(pw, V, `Probe ${kind}`)
    try {
      const stretch = [{ at: 40, seconds: gap }]
      probe.dollar(
        `fakeBroadcaster.mjs --url <probe camera> --stamped --duration 90 --${kind} 40:${gap}   # on the stack`
      )
      const cast = await pw.media.broadcast({
        url: one.url,
        stamped: true,
        duration: 90,
        ...(kind === 'jump' ? { jumps: stretch } : { stalls: stretch })
      })
      const done = await untilBroadcast(
        pw.media,
        cast.id,
        'the probe broadcast ending',
        status => status.exit != null,
        { timeoutMs: 600_000 }
      ).catch(async (error: unknown) => {
        const status = await pw.media.broadcastStatus(cast.id)
        if (status.exit != null) return status
        throw error
      })
      probe.say(`broadcaster exited ${done.exit}`)
      expect(done.exit, 'the broadcaster published').equals(0)
      await pause(6000)
      const playback = await pw.client.playback(one.videoId)
      if (playback.url == null)
        throw new Error('the probe camera has no address')
      const facts = await probe.playlist(`probe ${kind} ${gap}`, playback.url)
      heldToSegments(facts, seconds, `${kind} ${gap}`)
      expect(
        facts.discontinuities,
        `${kind} ${gap}: the writer was cut at the gap`
      ).greaterThan(0)
    } finally {
      probe.keep()
      await endCamera(pw, V, one.streamId).catch(() => undefined)
      // Removed as well: an ended camera still holds one of the four a person
      // may have on a game. Its recording stays.
      await removeCamera(pw, V, one.streamId)
    }
  }
}

async function tiles(ctx: HarnessContext): Promise<void> {
  const probe = new Probe(ctx)
  const pw = await playerWorld(ctx)
  const V = await liveGame(pw)
  try {
    const web = await playerWeb(pw, 1280, 720)
    const path = gridPath(V, V.videos.length)
    const seconds = 60
    probe.dollar(
      `open ${path} at 1280x720, read each tile once a second for ${seconds} s`
    )
    await open(web, path)
    await web.page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === ${V.videos.length} && v.every(one => one.readyState >= 2) })()`,
      { timeout: 90_000 }
    )
    const geometry = markerGeometry(720)
    const clocked = V.videos.map(() => 0)
    for (let second = 0; second < seconds; second++) {
      const now = Date.now()
      const reads = await videoReadings(web.page, readMarkerSource(), geometry)
      const row = reads.slice(0, V.videos.length).map((read, index) => {
        const behind =
          read.seekableEnd == null ? null : read.seekableEnd - read.currentTime
        const wall =
          read.markerLow32 == null ? null : unwrapMarker(read.markerLow32, now)
        if (wall != null) clocked[index] += 1
        return `tile ${index + 1}: behind ${behind == null ? '-' : behind.toFixed(1)} s, seeks ${read.seekingPerSec.toFixed(1)}/s, clock ${wall == null ? '-' : ((now - wall) / 1000).toFixed(2) + ' s ago'}${read.state == null ? '' : `, ${read.state}`}`
      })
      probe.say(`t+${String(second).padStart(3)}  ${row.join('  |  ')}`)
      await pause(1000 - (Date.now() - now))
    }
    for (const [index, count] of clocked.entries())
      expect(count, `tile ${index + 1}'s burned-in clock read`).greaterThan(0)
  } finally {
    probe.keep()
    await V.stop()
  }
}

export default defineHarness({
  id: 'playback/live-angles/writer-probe',
  title:
    'The live writer keeps its segments and target duration through a jump or a stall, and the live tiles read their clocks',
  kind: 'e2e',
  covers: [
    'src/server/live/timestampJump.ts',
    'src/server/live/splitter.ts',
    'src/server/live/wallAnchors.ts',
    'src/app/player/multiCam/**'
  ],
  stack: 'isolated',
  fixtures: ['player-layouts'],
  exclusive: false,
  surfaces: {
    // The tiles play the live HEVC angles: Chrome for Testing on the Mac.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 40,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    playlists,
    jump: publishOnce('jump', 34),
    stall: publishOnce('stall', 20),
    tiles
  }
})
