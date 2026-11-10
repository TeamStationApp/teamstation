/**
 * What the live multi-angle work is judged by, printed as `$`-lines and what
 * came back, for the proving logs. Needs the live ingest on this machine
 * (`npm run start.ingest`) beside the API.
 *
 *   node -r sucrase/register scripts/e2e/playerLayouts/liveProbe.ts \
 *     [--before] [--playlists] [--jump <seconds>] [--stall <seconds>] \
 *     [--tiles [--seconds 60]]
 *
 * - `--playlists` (the default): the fixture's live game V, both angles'
 *   media playlists, with their target duration, discontinuities and
 *   program date-times summed up.
 * - `--jump 34`: a camera of its own on V, published for 90 s with every
 *   timestamp from 40 s in moved forward by that much on the same
 *   connection (`fakeBroadcaster --jump`); its playlist after.
 * - `--stall 20`: the same with the publisher stopped 40 s in for that long
 *   and let go on the same connection (`fakeBroadcaster --stall`).
 * - `--tiles`: All Angles on V in a browser (`playerLayoutsRig.e2e.ts`),
 *   each tile read once a second: how far behind its newest footage it is,
 *   how often it seeks, and the wall clock burned into its picture.
 *
 * `--before` only labels the run. Environment as `playerLayoutsRig.e2e.ts`.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

import {
  API,
  finish,
  fixture,
  GRID_VIDEOS,
  open,
  pause,
  signedIn,
  videoReadings,
  webSession
} from '../../../e2e/rigs/playerLayoutsRig'
import { TeamStationClient } from '../../../src/common/api'
import { serverConfig } from '../../../src/server/serverConfig'

const { values } = parseArgs({
  options: {
    before: { type: 'boolean', default: false },
    playlists: { type: 'boolean', default: false },
    jump: { type: 'string' },
    stall: { type: 'string' },
    tiles: { type: 'boolean', default: false },
    seconds: { type: 'string', default: '60' }
  }
})

const marker = createRequire(__filename)('../scoreboardLog/readMarker.ts') as {
  markerGeometry: (height: number) => unknown
  readMarkerSource: () => string
  unwrapMarker: (low32: number, nearMs: number) => number
}

function dollar(line: string): void {
  console.log(`$ ${line}`)
}

/** A playlist and what matters in it. */
async function playlist(name: string, url: string): Promise<void> {
  dollar(`curl -s '<${name} playlist>'`)
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
  console.log(
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
    console.log(lines.slice(Math.max(0, index - 3), index + 4).join('\n'))
  })
}

async function client(): Promise<TeamStationClient> {
  return new TeamStationClient({ baseUrl: API, token: await signedIn() })
}

async function playlists(): Promise<void> {
  const f = fixture()
  const api = await client()
  for (const [index, videoId] of f.games.V.videos.entries()) {
    const playback = await api.playback(videoId)
    if (playback.url == null) throw new Error(`${videoId} has no address`)
    await playlist(`V angle ${index + 1}`, playback.url)
  }
}

/** A camera of its own on V, published with one jump or stall. */
async function publishOnce(
  kind: 'jump' | 'stall',
  seconds: number
): Promise<void> {
  const f = fixture()
  const api = await client()
  const token = await signedIn()
  const made = await fetch(`${API}/games/${f.games.V.id}/live-streams`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ label: `Probe ${kind}` })
  })
  const body = (await made.json()) as {
    id: string
    videoId: string
    url: string
  }
  const key = new URL(body.url.replace(/^rtmp:/, 'http:')).pathname
    .split('/')
    .pop()!
  const url = `rtmp://127.0.0.1:${serverConfig.live.port}/${serverConfig.live.app}/${key}`
  const args = ['--stamped', '--duration', '90', `--${kind}`, `40:${seconds}`]
  dollar(
    `node scripts/e2e/scoreboardLog/fakeBroadcaster.mjs --url <probe camera> ${args.join(' ')}`
  )
  const code = await new Promise<number>(resolve => {
    const child = spawn(
      process.execPath,
      ['scripts/e2e/scoreboardLog/fakeBroadcaster.mjs', '--url', url, ...args],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    child.on('exit', exit => {
      resolve(exit ?? 1)
    })
  })
  console.log(`broadcaster exited ${code}`)
  await pause(6000)
  const playback = await api.playback(body.videoId)
  if (playback.url == null) throw new Error('the probe camera has no address')
  await playlist(`probe ${kind} ${seconds}`, playback.url)
  await fetch(`${API}/games/${f.games.V.id}/live-streams/${body.id}/end`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  })
  // Removed as well: an ended camera still holds one of the four a person may
  // have on a game. Its recording stays.
  await fetch(`${API}/games/${f.games.V.id}/live-streams/${body.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` }
  })
}

async function tiles(): Promise<void> {
  const f = fixture()
  const V = f.games.V
  const session = await webSession('liveProbe', 1280, 720)
  const path = `/games/${V.id}?angles=${V.videos.join(',')}&audio=${V.videos[0]}`
  dollar(
    `open ${path} at 1280x720, read each tile once a second for ${values.seconds} s`
  )
  await open(session, path)
  await session.page.waitForFunction(
    `(() => { const v = ${GRID_VIDEOS}; return v.length === ${V.videos.length} && v.every(one => one.readyState >= 2) })()`,
    { timeout: 90_000 }
  )
  const geometry = marker.markerGeometry(720)
  for (let second = 0; second < Number(values.seconds); second++) {
    const now = Date.now()
    const reads = await videoReadings(
      session,
      marker.readMarkerSource(),
      geometry
    )
    const row = reads.slice(0, V.videos.length).map((read, index) => {
      const behind =
        read.seekableEnd == null ? null : read.seekableEnd - read.currentTime
      const wall =
        read.markerLow32 == null
          ? null
          : marker.unwrapMarker(read.markerLow32, now)
      return `tile ${index + 1}: behind ${behind == null ? '-' : behind.toFixed(1)} s, seeks ${read.seekingPerSec.toFixed(1)}/s, clock ${wall == null ? '-' : ((now - wall) / 1000).toFixed(2) + ' s ago'}${read.state == null ? '' : `, ${read.state}`}`
    })
    console.log(`t+${String(second).padStart(3)}  ${row.join('  |  ')}`)
    await pause(1000 - (Date.now() - now))
  }
  await finish()
}

async function main(): Promise<void> {
  console.log(
    `# liveProbe ${values.before ? '(before)' : '(after)'} ${new Date().toISOString()}`
  )
  if (values.jump != null) await publishOnce('jump', Number(values.jump))
  else if (values.stall != null)
    await publishOnce('stall', Number(values.stall))
  else if (values.tiles) await tiles()
  else await playlists()
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
