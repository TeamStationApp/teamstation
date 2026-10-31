// E11 and E12: Record Video opens the streaming screen with the Cameraman
// overlay, records and streams, and rides out an outage on a real phone.
// Through maestro-d's JavaScript client, on an iOS simulator or an iPhone, or
// on an Android phone with TS_STREAM_ANDROID_SERIAL in place of the UDID.
//
//   TS_STREAM_IOS_UDID=<device> | TS_STREAM_ANDROID_SERIAL=<adb serial> \
//   MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   [TS_STREAM_TEAM_ID=<WebDriverAgent signing team, for a real device>] \
//   TS_STREAM_API=http://<LAN address>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_HLS_ROOT=<the server's media directory>/work/videos \
//   TS_STREAM_EMAIL=<a seeded user who may film> TS_STREAM_GAME=<a game> \
//   [TS_STREAM_ANGLE=Home Plate] [TS_STREAM_TOKEN=<session>] \
//   [TS_STREAM_HOLD=LANDSCAPE_LEFT|LANDSCAPE_RIGHT] \
//   [TS_STREAM_ARTIFACT_DIR=<dir>] [TS_STREAM_HOLD_SECONDS=20] \
//   [TS_STREAM_OUTAGE_IP=<the phone's address on a shaped network> \
//    TS_STREAM_CONDITIONER=https://<conditioner>/v1] \
//   [TS_STREAM_RECORDING_DIR=<the take's parts, copied off the phone>] \
//   [TS_STREAM_WEBCAM_URL=<an RTSP(S) camera watching the phone, with sound;
//    required on a real iPhone, for the overlay's frame>] \
//     node -r sucrase/register src/app/stream/streamingScreen.e2e.ts
//
// The local server runs without mail, so it logs each sign-in link; the app
// is signed in through its own `teamstation://signin/` link.
//
// WebDriverAgent's orientation stands in for the phone's own while it runs,
// and the capture turns the picture by it: on a real phone, TS_STREAM_HOLD
// says which way up the phone is held, so the stream is upright. It is set
// once the streaming screen is up.
//
//   1. Record Video → the angle's name → Record with this phone.
//   2. The overlay: the name, "Press record to start stream", a thermal
//      label, and on a phone the battery. Screenshot.
//   3. Record → "Broadcasting"; ffprobe the live HLS (HEVC 1080p). With the
//      webcam, its frame of the overlay over the live camera.
//   4. Pinch, and read the zoom readout again.
//   E12, with TS_STREAM_OUTAGE_IP: the phone's address loses every packet for
//      20 s, then is capped at 1 Mbit/s for 60 s. The pill must read
//      "Connecting" during the cut and "Broadcasting" after it, the HLS must
//      be back within 8 s of the restore, the ingest at or below the cap once
//      it settles, and what arrives after the cap within the send budget.
//      `reconnect-live.mp4` is the live HLS around the cut.
//   5. Slide to Stop: the blue pill returns and the server hears that this
//      phone holds the recording. After E12, the phone's own recording is
//      copied off it (TS_STREAM_RECORDING_DIR where it cannot be, as from a
//      release Android build) and `ffprobe -show_frames` must find no gap of
//      more than a frame across either event. Close.
//   6. Back on the Videos tab, a finished video of the game plays: the
//      player's elapsed time moves. It is opened by its id, from its start:
//      the tab opens on the stream just stopped, which stays live for the
//      server's eight-minute reconnect grace, so its player holds the last picture at
//      the live edge. The game needs a finished video with sound; with
//      TS_STREAM_WEBCAM_URL, the camera's frame is kept and its sound must be
//      louder while the video plays than once it is paused.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { type AngleCandidate, angleLabels } from '../player/multiCam/takes'
import { screenOf } from './screenOf'

const run = promisify(execFile)

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  id?: string
  text?: string
  bounds?: Bounds
  children?: Node[]
}
interface Driver {
  hierarchy: () => Promise<Node>
  takeScreenshot: (options: { path: string }) => Promise<unknown>
  launchApp: (options: { appId: string; stopApp?: boolean }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (
    target: { text: string } | { id: string } | { point: string }
  ) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  setOrientation: (orientation: string) => Promise<unknown>
  scrollUntilVisible: (options: {
    element: { text: string }
    centerElement?: boolean
  }) => Promise<unknown>
  swipe: (gesture: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration: number
  }) => Promise<unknown>
  eval: (script: string) => Promise<{ status: number; body: string }>
  detach: () => Promise<unknown>
}
interface Daemon {
  info: { runDir: string }
  attach: (options: {
    device: string
    platform: 'ios' | 'android'
    appId: string
    teamId?: string
  }) => Promise<Driver>
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
// TS_STREAM_ANDROID_SERIAL drives an Android phone instead of an iOS device.
const androidSerial = process.env.TS_STREAM_ANDROID_SERIAL
const android = androidSerial != null && androidSerial !== ''
const device = android ? androidSerial : required('TS_STREAM_IOS_UDID')
const daemonName = required('MAESTRO_D')
const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
const api = required('TS_STREAM_API').replace(/\/$/, '')
const serverLog = required('TS_STREAM_SERVER_LOG')
const hlsRoot = required('TS_STREAM_HLS_ROOT')
const email = required('TS_STREAM_EMAIL')
const game = required('TS_STREAM_GAME')
const angle = process.env.TS_STREAM_ANGLE ?? 'Home Plate'
const teamId = process.env.TS_STREAM_TEAM_ID
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const holdSeconds = Number(process.env.TS_STREAM_HOLD_SECONDS ?? '20')
const hold = process.env.TS_STREAM_HOLD
const outageIp = process.env.TS_STREAM_OUTAGE_IP
const conditioner = process.env.TS_STREAM_CONDITIONER
const webcam = process.env.TS_STREAM_WEBCAM_URL
const APP = 'app.teamstation.app'
// A simulator's UDID; a real iPhone's is not of this shape.
const isSimulator = /^[0-9A-F]{8}-[0-9A-F]{4}-/.test(device)
// E11 on the iPhone keeps a frame of the overlay over the live camera, which
// only the bench camera can see.
assert(
  android || isSimulator || (webcam != null && webcam !== ''),
  'TS_STREAM_WEBCAM_URL is required on a real iPhone: E11 keeps a webcam frame of the overlay over the live camera'
)

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const started = Date.now()
const say = (line: string): void => {
  console.log(
    `${new Date().toISOString()} +${((Date.now() - started) / 1000).toFixed(1)}s ${line}`
  )
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const centre = (bounds: Bounds): { x: number; y: number } => ({
  x: Math.round(bounds.x + bounds.width / 2),
  y: Math.round(bounds.y + bounds.height / 2)
})

/** The newest match of `pattern` in the server's log, after `offset` characters. */
async function fromServerLog(pattern: RegExp, offset: number): Promise<string> {
  for (const until = Date.now() + 20000; Date.now() < until;) {
    const match = pattern.exec(
      (await readFile(serverLog, 'utf8')).slice(offset)
    )
    if (match?.[1] != null) return match[1]
    await sleep(300)
  }
  throw new Error(`Nothing matching ${String(pattern)} in the server log`)
}

const request = async (
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<Response> =>
  await fetch(`${api}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token == null ? {} : { authorization: `Bearer ${token}` })
    },
    body: body == null ? undefined : JSON.stringify(body)
  })

/** Asks for a sign-in mail; the local server logs its code and link instead. */
async function askToSignIn(): Promise<{ code: string; link: string }> {
  const offset = (await readFile(serverLog, 'utf8')).length
  const asked = await request('POST', '/auth/email-code', { email })
  assert.equal(asked.status, 202, 'the sign-in code was sent')
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const code = await fromServerLog(
    new RegExp(`sign-in code for ${escaped}: (\\d{6})`),
    offset
  )
  const link = await fromServerLog(
    /link: https?:\/\/[^/\s]+\/signin\/([A-Za-z0-9_-]+)/,
    offset
  )
  return { code, link }
}

/** A session for the test's own API calls: `TS_STREAM_TOKEN`, or a fresh sign-in. */
async function apiToken(): Promise<string> {
  const given = process.env.TS_STREAM_TOKEN
  if (given != null && given !== '') return given
  const { code } = await askToSignIn()
  const verified = await request('POST', '/auth/email-code/verify', {
    email,
    code
  })
  assert.equal(verified.status, 200, 'the sign-in code was accepted')
  return ((await verified.json()) as { token: string }).token
}

interface StreamRow {
  id: string
  label: string
  state: string
  videoId: string | null
  deviceModel?: string | null
  localRecording?: string
  status: {
    ingress: {
      publishing: boolean
      bytesPerSecond: number
      bytesReceived: number
    }
  } | null
}

async function myStream(token: string): Promise<StreamRow> {
  const answer = await request(
    'GET',
    `/games/${game}/live-streams`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the game’s cameras were listed')
  const { mine } = (await answer.json()) as { mine: StreamRow[] }
  const row = mine.find(
    one =>
      one.label.toLowerCase() === angle.toLowerCase() && one.deviceModel != null
  )
  assert(row != null, `this phone’s ${angle} stream is listed`)
  return row
}

/** The live HLS of a video: its playlist, and how many segments it lists. */
async function playlist(
  videoId: string
): Promise<{ file: string; segments: number }> {
  const file = path.join(hlsRoot, videoId, 'master.m3u8')
  try {
    const text = await readFile(file, 'utf8')
    return {
      file,
      segments: text.split('\n').filter(line => line.startsWith('#EXTINF'))
        .length
    }
  } catch {
    return { file, segments: 0 }
  }
}

async function shape(shapes: Array<Record<string, unknown>>): Promise<void> {
  assert(
    conditioner != null,
    'TS_STREAM_CONDITIONER is required for the outage'
  )
  // The conditioner's certificate is its own, so curl rather than fetch.
  const { stdout } = await run('curl', [
    '-sk',
    '-X',
    'POST',
    `${conditioner}/shape`,
    '-H',
    'content-type: application/json',
    '-d',
    JSON.stringify({ merge: true, shapes })
  ])
  say(`conditioner: ${stdout.trim()}`)
}

/** Records `seconds` of the webcam, picture and sound, into `file`. */
async function filmPhone(file: string, seconds: number): Promise<void> {
  assert(webcam != null, 'TS_STREAM_WEBCAM_URL is required')
  await run(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      ...(webcam.startsWith('rtsps:') ? ['-tls_verify', '0'] : []),
      '-timeout',
      '15000000',
      '-i',
      webcam,
      '-t',
      String(seconds),
      '-c',
      'copy',
      '-y',
      file
    ],
    { timeout: (seconds + 30) * 1000 }
  )
}

/** The mean loudness of a recording's sound, in dB. */
async function meanVolume(file: string): Promise<number> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-'
  ])
  const match = /mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr)
  assert(match != null, `volumedetect said nothing: ${stderr.slice(-400)}`)
  return match[1] === '-inf' ? -Infinity : Number(match[1])
}

/** One frame of the webcam watching the phone, into `file`. */
async function webcamFrame(file: string): Promise<void> {
  assert(webcam != null, 'TS_STREAM_WEBCAM_URL is required')
  await run(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      ...(webcam.startsWith('rtsps:') ? ['-tls_verify', '0'] : []),
      '-timeout',
      '15000000',
      '-i',
      webcam,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-y',
      file
    ],
    { timeout: 45000 }
  )
  assert((await stat(file)).size > 0, `the webcam gave a frame in ${file}`)
}

/** When E12's two events happened, for the checks that follow them. */
interface OutageTimes {
  cutAt: number
  restoredAt: number
  throttleEndedAt: number
}

/** How long E12 cuts the phone off, and how long it caps it. */
const CUT_SECONDS = 20
const THROTTLE_SECONDS = 60
/** The cap during the throttle, in Mbit/s. */
const CAP_MBIT = 1
/**
 * The engines' send budget, `RTMPClient.sendBudget` at the phone's highest
 * bitrate: 4 Mbit/s for 30 s of stream, half as much again. What waits to be
 * sent never grows past it; older pictures are shed first.
 */
const SEND_BUDGET_BYTES = (4_000_000 / 8) * 30 * 1.5

/**
 * The live HLS of the outage, from 10 s before the cut to 30 s after the
 * restore, copied into `file`: the segments the playlist lists with a
 * written time in that window, each under the init segment it follows.
 */
async function clipAround(
  playlistFile: string,
  fromMs: number,
  toMs: number,
  file: string
): Promise<number> {
  const dir = path.dirname(playlistFile)
  const absolute = (uri: string): string =>
    path.isAbsolute(uri) ? uri : path.join(dir, uri)
  const lines = (await readFile(playlistFile, 'utf8')).split('\n')
  const kept = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10']
  let map: string | undefined
  let mapWritten: string | undefined
  let writtenAt: number | undefined
  let duration: string | undefined
  let gap = false
  let segments = 0
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      map = line.replace(/URI="([^"]+)"/, (_all, uri: string) => {
        return `URI="${absolute(uri)}"`
      })
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      writtenAt = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length))
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      gap = true
    } else if (line.startsWith('#EXTINF:')) {
      duration = line
    } else if (line !== '' && !line.startsWith('#') && duration != null) {
      if (writtenAt != null && writtenAt >= fromMs && writtenAt <= toMs) {
        if (gap && segments > 0) kept.push('#EXT-X-DISCONTINUITY')
        if (map != null && (map !== mapWritten || gap)) {
          kept.push(map)
          mapWritten = map
        }
        kept.push(duration, absolute(line))
        segments += 1
        gap = false
      }
      duration = undefined
    }
  }
  kept.push('#EXT-X-ENDLIST', '')
  const list = `${file}.m3u8`
  await writeFile(list, kept.join('\n'))
  await run('ffmpeg', [
    '-nostdin',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
    '-allowed_extensions',
    'ALL',
    '-i',
    list,
    '-c',
    'copy',
    '-y',
    file
  ])
  return segments
}

/**
 * E12: the phone loses every packet for 20 s, then is capped at 1 Mbit/s for
 * 60 s. Asserts the plan's expectations: "Connecting" during the cut and
 * "Broadcasting" after it, the HLS back within 8 s of the restore, the ingest
 * at or below the cap once it settles under it, and no more arriving after
 * the cap than the send budget could have held. Keeps `reconnect-live.mp4`.
 */
async function rideOutage(options: {
  token: string
  videoId: string
  pill: () => Promise<string>
  results: string[]
}): Promise<OutageTimes> {
  const { token, videoId, pill, results } = options
  assert(outageIp != null, 'TS_STREAM_OUTAGE_IP is required for E12')
  // The writer for the new connection appends after a discontinuity; the
  // segment the old writer flushes as its stream ends does not count.
  const joins = async (): Promise<{ joins: number; after: number }> => {
    const text = await readFile((await playlist(videoId)).file, 'utf8').catch(
      () => ''
    )
    const parts = text.split('#EXT-X-DISCONTINUITY')
    return {
      joins: parts.length - 1,
      after: (parts.at(-1) ?? '')
        .split('\n')
        .filter(line => line.startsWith('#EXTINF')).length
    }
  }

  const cutAt = Date.now()
  say(`cut: 100% loss on the phone for ${CUT_SECONDS} s`)
  await shape([{ ip: outageIp, lossPct: 100 }])
  const seen: string[] = []
  for (const until = cutAt + CUT_SECONDS * 1000; Date.now() < until;) {
    const now = await pill()
    if (seen.at(-1) !== now) seen.push(now)
    await sleep(1000)
  }
  const joinsAtRestore = (await joins()).joins
  await shape([{ ip: outageIp }])
  const restoredAt = Date.now()
  say(`restored; the pill read ${seen.join(' → ')} during the cut`)
  assert(
    seen.includes('Connecting'),
    `the pill reads Connecting during the cut (it read ${seen.join(' → ')})`
  )
  let resumed: number | undefined
  let broadcasting: number | undefined
  for (
    const until = restoredAt + 60000;
    Date.now() < until && (resumed == null || broadcasting == null);
  ) {
    if (broadcasting == null && (await pill()) === 'Broadcasting')
      broadcasting = (Date.now() - restoredAt) / 1000
    const now = await joins()
    if (resumed == null && now.joins > joinsAtRestore && now.after > 0)
      resumed = (Date.now() - restoredAt) / 1000
    await sleep(500)
  }
  assert(
    broadcasting != null,
    'the pill reads Broadcasting again after the restore'
  )
  // The phone redials within a second of its network returning (Android through its 6 s stall
  // redial when TCP backoff holds the dead connection). The viewer then waits for the server's first
  // new segment: 4 s, or 6 s when the 2 s keyframes land a few ms short of the cut. So the live
  // video is back within 8 s (measured 5.1 to 7.1 s on the iPhone, 5.9 to 6.8 s on the Pixel).
  const resumeBudget = 8
  assert(
    resumed != null && resumed <= resumeBudget,
    `the HLS resumes within ${resumeBudget} s of the restore (${resumed?.toFixed(1) ?? 'never'} s)`
  )
  results.push(
    `E12 cut ${new Date(cutAt).toISOString()}: pill ${seen.join(' → ')} during the cut; Broadcasting ${broadcasting.toFixed(1)} s and the new connection's first segment in the HLS ${resumed.toFixed(1)} s after the restore`
  )

  say(`throttle: ${CAP_MBIT} Mbit/s for ${THROTTLE_SECONDS} s`)
  await shape([{ ip: outageIp, mbit: CAP_MBIT }])
  const throttledAt = Date.now()
  const rates: number[] = []
  const pills = new Set<string>()
  for (
    const until = throttledAt + THROTTLE_SECONDS * 1000;
    Date.now() < until;
  ) {
    await sleep(5000)
    const sample = await myStream(token)
    rates.push(((sample.status?.ingress.bytesPerSecond ?? 0) * 8) / 1e6)
    pills.add(await pill())
  }
  const beforeLift = (await myStream(token)).status?.ingress.bytesReceived ?? 0
  await shape([{ ip: outageIp }])
  const throttleEndedAt = Date.now()
  // The last 30 s under the cap: the controller has settled by then.
  const settled = rates.slice(-6)
  const mean =
    settled.reduce((sum, value) => sum + value, 0) / Math.max(settled.length, 1)
  say(
    `ingest Mbit/s every 5 s under the cap: ${rates.map(rate => rate.toFixed(2)).join(' ')}`
  )
  assert(settled.length > 0, 'the ingest was sampled under the cap')
  assert(
    mean <= CAP_MBIT,
    `the stream settles at or below ${CAP_MBIT} Mbit/s under the cap (last 30 s mean ${mean.toFixed(2)})`
  )
  // Whatever waited to be sent under the cap arrives once it lifts, on top
  // of what the encoder makes meanwhile; it can be no more than the budget.
  const DRAIN_SECONDS = 20
  await sleep(DRAIN_SECONDS * 1000)
  const afterLift = (await myStream(token)).status?.ingress.bytesReceived ?? 0
  // A counter that went back is a new connection, which counts from nought.
  const delivered = afterLift >= beforeLift ? afterLift - beforeLift : afterLift
  const encoded = (CAP_MBIT * 1e6 * DRAIN_SECONDS) / 8
  const backlog = Math.max(0, delivered - encoded)
  assert(
    backlog <= SEND_BUDGET_BYTES,
    `the backlog drained after the cap (${(backlog / 1e6).toFixed(1)} MB) stays within the send budget (${(SEND_BUDGET_BYTES / 1e6).toFixed(1)} MB)`
  )
  results.push(
    `E12 throttle ${CAP_MBIT} Mbit/s: ingest ${rates.map(rate => rate.toFixed(2)).join(' ')} Mbit/s, last 30 s mean ${mean.toFixed(2)}; pill ${[...pills].join(', ')}; ${(delivered / 1e6).toFixed(1)} MB in the ${DRAIN_SECONDS} s after, a backlog of at most ${(backlog / 1e6).toFixed(1)} MB against a ${(SEND_BUDGET_BYTES / 1e6).toFixed(1)} MB budget`
  )

  const clip = path.join(artifacts ?? tmpdir(), 'reconnect-live.mp4')
  const segments = await clipAround(
    (await playlist(videoId)).file,
    cutAt - 10000,
    restoredAt + 30000,
    clip
  )
  assert(segments > 0, 'the live HLS has segments around the cut')
  say(`$ ffmpeg ${path.basename(clip)}: ${segments} segments around the cut`)
  results.push(`E12 ${clip}: ${segments} live segments around the cut`)
  await writeFile(
    path.join(artifacts ?? tmpdir(), 'e12-times.json'),
    JSON.stringify({
      cutAt: new Date(cutAt).toISOString(),
      restoredAt: new Date(restoredAt).toISOString(),
      throttleEndedAt: new Date(throttleEndedAt).toISOString(),
      videoId
    })
  )
  return { cutAt, restoredAt, throttleEndedAt }
}

/**
 * The phone's own recording parts, copied off it into `dir`: from the app's
 * data container on an iPhone or a simulator, and on Android with `run-as`,
 * which needs a debuggable build, or from TS_STREAM_RECORDING_DIR where the
 * parts were copied some other way.
 */
async function pullRecording(dir: string): Promise<string> {
  const given = process.env.TS_STREAM_RECORDING_DIR
  if (given != null && given !== '') return given
  await mkdir(dir, { recursive: true })
  const program = 'Library/Application Support/PhoneStream/Program'
  if (android) {
    try {
      const { stdout } = await run(
        'adb',
        [
          '-s',
          device,
          'exec-out',
          'run-as',
          APP,
          'tar',
          '-c',
          '-C',
          'files/phoneStream',
          'Program'
        ],
        { encoding: 'buffer', maxBuffer: 1 << 30 }
      )
      const tarball = path.join(dir, 'program.tar')
      await writeFile(tarball, stdout)
      await run('tar', ['-x', '-f', tarball, '-C', dir])
      return path.join(dir, 'Program')
    } catch (error) {
      throw new Error(
        `The local recording cannot be read off ${device}: run-as needs a debuggable build. Copy the take's parts from files/phoneStream/Program and set TS_STREAM_RECORDING_DIR. (${String(error)})`
      )
    }
  }
  if (isSimulator) {
    const { stdout } = await run('xcrun', [
      'simctl',
      'get_app_container',
      device,
      APP,
      'data'
    ])
    return path.join(stdout.trim(), program)
  }
  await run('xcrun', [
    'devicectl',
    'device',
    'copy',
    'from',
    '--device',
    device,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    APP,
    '--source',
    program,
    '--destination',
    dir
  ])
  return dir
}

/**
 * E12's last expectation: the phone's recording of the take shows no gap of
 * more than a frame across either event. Read once the take has stopped, so
 * its part is whole.
 */
async function checkLocalRecording(outage: OutageTimes): Promise<string> {
  const dir = await pullRecording(
    path.join(artifacts ?? tmpdir(), 'e12-recording')
  )
  const parts: string[] = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.mp4')) continue
    const file = path.join(dir, name)
    // Written since the cut: the part the events happened in.
    if ((await stat(file)).mtimeMs >= outage.cutAt) parts.push(file)
  }
  assert(parts.length > 0, `the take's part is among ${dir}`)
  const span = (outage.throttleEndedAt - outage.cutAt) / 1000
  const lines: string[] = []
  for (const file of parts) {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'csv=p=0',
        file
      ],
      { maxBuffer: 1 << 28 }
    )
    const times = stdout
      .split('\n')
      .map(line => Number(line.split(',')[0]))
      .filter(time => Number.isFinite(time))
      .sort((a, b) => a - b)
    assert(times.length > 1, `${path.basename(file)} has frames`)
    const steps = times.slice(1).map((time, index) => time - times[index])
    const frame = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]
    const longest = Math.max(...steps)
    const length = times[times.length - 1] - times[0]
    lines.push(
      `${path.basename(file)}: ${times.length} frames over ${length.toFixed(1)} s, frame ${(frame * 1000).toFixed(1)} ms, longest step ${(longest * 1000).toFixed(1)} ms`
    )
    if (length < span) continue
    // One frame missing at most: never more than two frame times apart.
    assert(
      longest <= frame * 2 + 0.001,
      `${path.basename(file)} has a gap of ${(longest * 1000).toFixed(1)} ms, more than a frame`
    )
  }
  assert(
    lines.some(line => Number(/over ([\d.]+) s/.exec(line)?.[1]) >= span),
    `a part spans both events (${span.toFixed(0)} s): ${lines.join('; ')}`
  )
  say(`$ ffprobe -show_frames: ${lines.join('; ')}`)
  return `E12 local recording, no gap over a frame across either event: ${lines.join('; ')}`
}

/** "0:19 elapsed" or "1:02:03 elapsed" in seconds. */
const elapsedSeconds = (text: string): number =>
  (/^([\d:]+)/.exec(text)?.[1] ?? '')
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0)

async function main(): Promise<void> {
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const daemon = await MaestroD.connect({ name: daemonName, spawn: true })
  const m = await daemon.attach({
    device,
    platform: android ? 'android' : 'ios',
    appId: APP,
    ...(teamId == null ? {} : { teamId })
  })
  const results: string[] = []
  if (artifacts != null) await mkdir(artifacts, { recursive: true })

  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const find = async (
    test: (node: Node) => boolean,
    wait = 10000
  ): Promise<Node | undefined> => {
    for (const until = Date.now() + wait; ;) {
      const found = (await nodes()).find(
        node => test(node) && node.bounds != null && node.bounds.width > 0
      )
      if (found != null) return found
      if (Date.now() > until) return undefined
      await sleep(400)
    }
  }
  const byText = (text: string) => (node: Node) => node.text === text
  const byId = (id: string) => (node: Node) => node.id === id
  const textOf = async (id: string): Promise<string | undefined> =>
    (await find(byId(id), 3000))?.text ??
    (await nodes())
      .find(node => node.id === id)
      ?.children?.map(child => child.text ?? '')
      .join('')
  const pill = async (): Promise<string> => {
    const words = [
      'Press record to start stream',
      'Connecting',
      'Broadcasting',
      'Stream ended'
    ]
    const shown = (await nodes())
      .map(node => node.text)
      .find(text => words.includes(text ?? ''))
    return shown ?? '?'
  }
  const waitForPill = async (want: string, wait: number): Promise<number> => {
    const from = Date.now()
    for (const until = from + wait; Date.now() < until;) {
      if ((await pill()) === want) return (Date.now() - from) / 1000
      await sleep(500)
    }
    throw new Error(`The pill never read ${want}; it reads ${await pill()}`)
  }
  const shot = async (name: string): Promise<void> => {
    if (artifacts == null) return
    say(`$ takeScreenshot ${name}`)
    await m.takeScreenshot({ path: path.join(artifacts, name) })
  }

  try {
    say('$ launchApp')
    await m.launchApp({ appId: APP, stopApp: true })
    if ((await find(byText('Sign in to TeamStation'), 12000)) != null) {
      const { link } = await askToSignIn()
      say('$ openLink teamstation://signin/<token>')
      await m.openLink({ link: `teamstation://signin/${link}` })
      await sleep(3000)
      if ((await find(byId('signInLinkSignIn'), 3000)) != null)
        await m.tapOn({ id: 'signInLinkSignIn' })
    }
    const token = await apiToken()

    // 1. Record Video, the prompt, Record with this phone.
    say(`$ openLink teamstation://games/${game}?tab=watch`)
    await m.openLink({ link: `teamstation://games/${game}?tab=watch` })
    await sleep(3000)
    if (android) {
      // maestro-d's scroll swipes across the middle of the screen, which on
      // Android is the game's video player, and the player keeps the swipe:
      // swipe below it instead (the hierarchy holds only what is on screen).
      const below = async (): Promise<boolean> => {
        // Off screen, or reaching down to where the floating tab bar starts.
        const bounds = (await find(byText('Record Video'), 1000))?.bounds
        const screen = (await m.hierarchy()).bounds?.height ?? 2400
        return bounds == null || bounds.y + bounds.height > screen * 0.88
      }
      for (let i = 0; i < 10 && (await below()); i++) {
        say('$ swipe 50%,78% → 50%,30%')
        await (
          m as unknown as {
            swipe: (gesture: unknown) => Promise<unknown>
          }
        ).swipe({ start: '50%, 78%', end: '50%, 30%', duration: 600 })
        await sleep(800)
      }
    } else {
      say('$ scrollUntilVisible Record Video')
      await m.scrollUntilVisible({
        element: { text: 'Record Video' },
        centerElement: true
      })
    }
    say('$ tapOn Record Video')
    const recordVideo = android
      ? await find(byText('Record Video'), 3000)
      : undefined
    if (recordVideo?.bounds != null) {
      // In the middle: the watch tab leaves room under its last row for the
      // floating tab bar, so the whole button is clear of it.
      const { x, y, width, height } = recordVideo.bounds
      await m.tapOn({
        point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
      })
    } else {
      await m.tapOn({ text: 'Record Video' })
    }
    assert(
      (await find(byText('Name this camera angle'))) != null,
      'Record Video asks for the angle’s name'
    )
    await shot('angle-name-prompt')
    say(`$ inputText ${angle}`)
    await m.inputText({ text: angle })
    say('$ tapOn Record with this phone')
    await m.tapOn({ text: 'Record with this phone' })
    const badge = await find(
      node => node.id === 'camera-name' || node.text === angle,
      20000
    )
    assert(
      badge != null && (await find(byId('broadcast-button'), 10000)) != null,
      'the streaming screen opened'
    )
    results.push(
      `1 Record Video → “${angle}” → Record with this phone opened the streaming screen`
    )
    // Once the screen is up: WebDriverAgent refuses to turn an upright-only one.
    if (hold != null) {
      say(`$ setOrientation ${hold}`)
      await m.setOrientation(hold)
    }

    // 2. The overlay at rest.
    await sleep(2000)
    const shown = (await nodes()).map(node => node.text ?? '')
    assert(shown.includes(angle), 'the badge names the angle')
    assert.equal(await pill(), 'Press record to start stream')
    const thermal = shown.find(text =>
      /^(🔥)?(COOL|FAIR|WARM|HOT)(🔥)?$/.test(text)
    )
    assert(thermal != null, 'a thermal label shows')
    const battery = shown.find(text => /^\d{1,3}%$/.test(text))
    if (!isSimulator) assert(battery != null, 'the battery shows')
    const zoom = await textOf('zoom-label')
    results.push(
      `2 overlay: “${angle}”, “Press record to start stream”, ${thermal}, battery ${battery ?? 'none (a simulator reports none)'}, zoom ${zoom ?? '?'}`
    )
    await shot('stream-overlay-idle')

    // 3. Record, and the live HLS.
    say('$ tapOn broadcast-button')
    await m.tapOn({ id: 'broadcast-button' })
    const toLive = await waitForPill('Broadcasting', 45000)
    say(`Broadcasting after ${toLive.toFixed(1)} s`)
    const row = await myStream(token)
    assert(row.videoId != null, 'the stream has a live video')
    let hls = await playlist(row.videoId)
    for (
      const until = Date.now() + 30000;
      hls.segments < 2 && Date.now() < until;
    ) {
      await sleep(1000)
      hls = await playlist(row.videoId)
    }
    assert(hls.segments >= 2, 'the live HLS has segments')
    const { stdout: probe } = await run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,profile,width,height,r_frame_rate',
      '-of',
      'compact=p=0',
      hls.file
    ])
    const probed = probe.trim().split('\n')[0]
    say(`$ ffprobe ${path.basename(hls.file)}: ${probed}`)
    assert(
      probe.includes('codec_name=hevc') &&
        probe.includes('width=1920') &&
        probe.includes('height=1080'),
      'HEVC 1080p'
    )
    results.push(
      `3 Broadcasting after ${toLive.toFixed(1)} s; live HLS ${probed}`
    )
    say('$ tapOn broadcast-button (shows Slide to Stop)')
    await m.tapOn({ id: 'broadcast-button' })
    assert(
      (await find(byId('slide-to-stop-track'), 5000)) != null,
      'Slide to Stop shows'
    )
    await shot('stream-overlay-live')
    if (webcam != null) {
      // The overlay on the phone itself, over its live camera, as the bench
      // camera sees it.
      const frame = path.join(
        artifacts ?? tmpdir(),
        'stream-overlay-webcam.jpg'
      )
      say('$ ffmpeg webcam frame (the overlay over the live camera)')
      await webcamFrame(frame)
      results.push(`3 webcam frame of the overlay: ${frame}`)
    }
    say('$ tapOn slide-to-stop-dismiss')
    await m.tapOn({ id: 'slide-to-stop-dismiss' })

    // 4. Pinch out from the middle of the picture, with two fingers.
    const before = await textOf('zoom-label')
    // The W3C actions endpoint of the driver behind maestro-d: WebDriverAgent
    // on iOS, the UIAutomator2 server (through maestro-d's adb socket) on
    // Android. maestro-d has no two-finger gesture of its own.
    const daemonLog = await readFile(
      path.join(daemon.info.runDir, 'daemon.log'),
      'utf8'
    )
    let postActions: (body: string) => Promise<{ status: number; body: string }>
    if (android) {
      const sessionId = daemonLog
        .split('\n')
        .filter(line => line.includes('Session created successfully: '))
        .at(-1)
        ?.split('Session created successfully: ')[1]
        ?.trim()
      assert(sessionId != null, 'the UIAutomator2 session is in the daemon log')
      postActions = async body => {
        const { stdout } = await run('curl', [
          '-s',
          '-w',
          '\n%{http_code}',
          '--unix-socket',
          `/tmp/uia2-${device}.sock`,
          '-H',
          'content-type: application/json',
          '-d',
          body,
          `http://localhost/session/${sessionId}/actions`
        ])
        const lines = stdout.trim().split('\n')
        return {
          status: Number(lines.at(-1)),
          body: lines.slice(0, -1).join('\n')
        }
      }
    } else {
      const log = (
        await readFile(path.join(daemon.info.runDir, 'daemon.log'), 'utf8')
      ).split('\n')
      // Where the daemon reached WebDriverAgent: a usbmuxd forward on
      // localhost, or the CoreDevice tunnel address for a phone that usbmuxd
      // does not list. Older daemons only log the forwarded port.
      const reached = log
        .map(line => /WDA on (\S+) reached over .+ at (\S+)$/.exec(line))
        .filter(match => match != null)
      const url = (reached.filter(match => match[1] === device).at(-1) ??
        reached.at(-1))?.[2]
      const port = log
        .filter(line =>
          line.includes(`Starting WDA on device ${device} (port:`)
        )
        .at(-1)
        ?.match(/\(port: (\d+)\)/)?.[1]
      assert(
        url != null || port != null,
        'this device’s WebDriverAgent address is in the daemon log'
      )
      const wda = url ?? `http://127.0.0.1:${port}`
      const status = await m.eval(
        `http.get(${JSON.stringify(`${wda}/status`)})`
      )
      const { sessionId } = JSON.parse(status.body) as { sessionId: string }
      postActions = async body =>
        await m.eval(
          `http.post(${JSON.stringify(`${wda}/session/${sessionId}/actions`)}, {body:${JSON.stringify(body)}})`
        )
    }
    const screen = screenOf(await m.hierarchy())
    const mid = {
      x: Math.round(screen.width * 0.45),
      y: Math.round(screen.height / 2)
    }
    const finger = (
      id: string,
      direction: number
    ): Record<string, unknown> => ({
      type: 'pointer',
      id,
      parameters: { pointerType: 'touch' },
      actions: [
        {
          type: 'pointerMove',
          duration: 0,
          x: mid.x + 20 * direction,
          y: mid.y,
          origin: 'viewport'
        },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 100 },
        {
          type: 'pointerMove',
          duration: 600,
          x: mid.x + 140 * direction,
          y: mid.y,
          origin: 'viewport'
        },
        { type: 'pointerUp', button: 0 }
      ]
    })
    say('$ pinch out from the middle of the picture')
    const pinched = await postActions(
      JSON.stringify({ actions: [finger('left', -1), finger('right', 1)] })
    )
    assert.equal(pinched.status, 200, pinched.body)
    // The readout follows the lens a moment after the fingers lift.
    const deadline = Date.now() + 5000
    let after = await textOf('zoom-label')
    while (after === before && Date.now() < deadline) {
      await sleep(250)
      after = await textOf('zoom-label')
    }
    assert.ok(before != null, 'the zoom readout shows before the pinch')
    assert.notEqual(
      after,
      before,
      `the pinch changes the zoom readout (still ${before} after 5 s)`
    )
    results.push(`4 pinch: zoom readout ${before} → ${after ?? '?'}`)

    // E12: the outage.
    let outage: OutageTimes | undefined
    if (outageIp != null) {
      outage = await rideOutage({
        token,
        videoId: row.videoId,
        pill,
        results
      })
    } else if (holdSeconds > 0) {
      await sleep(holdSeconds * 1000)
    }

    // 5. Slide to Stop, then Close.
    say('$ tapOn broadcast-button (shows Slide to Stop)')
    await m.tapOn({ id: 'broadcast-button' })
    const knob = await find(byId('slide-to-stop-knob'), 5000)
    const track = await find(byId('slide-to-stop-track'), 5000)
    assert(knob?.bounds != null && track?.bounds != null, 'Slide to Stop shows')
    const from = centre(knob.bounds)
    const to = { x: track.bounds.x + track.bounds.width - 4, y: from.y }
    say(`$ swipe ${from.x},${from.y} → ${to.x},${to.y}`)
    await m.swipe({
      startX: from.x,
      startY: from.y,
      endX: to.x,
      endY: to.y,
      duration: 800
    })
    const toIdle = await waitForPill('Press record to start stream', 20000)
    let recorded: string | undefined
    for (const until = Date.now() + 10000; Date.now() < until;) {
      recorded = (await myStream(token)).localRecording
      if (recorded === 'recorded') break
      await sleep(500)
    }
    assert.equal(
      recorded,
      'recorded',
      'the server heard this phone holds the recording'
    )
    results.push(
      `5 Slide to Stop: blue pill back after ${toIdle.toFixed(1)} s; localRecording ${recorded}`
    )
    if (outage != null) results.push(await checkLocalRecording(outage))
    say('$ tapOn camera-close')
    await m.tapOn({ id: 'camera-close' })
    assert(
      // Android lists only what is on the screen, and the game page comes
      // back at its top, with Record Video below the fold.
      (await find(byText(android ? 'Box score' : 'Record Video'), 10000)) !=
        null,
      'Close goes back to the game'
    )
    const recordingStat = await stat(hls.file)
    results.push(
      `5 closed; the live HLS playlist last written ${recordingStat.mtime.toISOString()}`
    )

    // 6. A finished video of the game plays, with sound, now the camera has
    // let go. Not the stream just stopped: until its publisher has been away
    // for the reconnect grace it is still live, and a live player sits at the
    // live edge. The page opens again on the finished video, from its start;
    // going home first, because the game's page keeps the video it has.
    const listed = await request('GET', `/games/${game}`, undefined, token)
    assert.equal(listed.status, 200, 'the game was read')
    const { videos } = (await listed.json()) as { videos: AngleCandidate[] }
    const finished = videos.find(
      video => video.status === 'ready' && video.id !== row.videoId
    )
    assert(
      finished != null,
      `step 6 plays a finished video of the game with sound, and ${game} has none besides the stream just stopped`
    )
    const finishedName =
      angleLabels(videos).find(label => label.id === finished.id)?.name ??
      finished.title
    say('$ openLink teamstation://home')
    await m.openLink({ link: 'teamstation://home' })
    await sleep(2000)
    say(`$ openLink teamstation://games/${game}?video=${finished.id}`)
    await m.openLink({
      link: `teamstation://games/${game}?video=${finished.id}`
    })
    await sleep(3000)
    // Android's player is ExoPlayer's view, whose controls have its own ids.
    const androidIds: Record<string, string> = {
      Video: 'exo_content_frame',
      'Play/Pause': 'exo_play_pause',
      'Elapsed Time': 'exo_position',
      'Mute/Unmute': 'exo_volume'
    }
    const isControl = (node: Node, id: string): boolean =>
      node.id === id ||
      (android && node.id === `${APP}:id/${androidIds[id] ?? id}`)
    const player = await find(
      node => isControl(node, 'Video') || node.text === 'Video',
      10000
    )
    assert(player?.bounds != null, 'the Videos tab has a player')
    // With its controls hidden, a tap on the player only shows them (they
    // hide again after a few seconds of playback); read them at once.
    const middle = centre(player.bounds)
    const control = async (id: string): Promise<Node | undefined> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const shown = (await nodes()).find(
          node => isControl(node, id) && node.bounds != null
        )
        if (shown != null) return shown
        say('$ tapOn the player (shows its controls)')
        await m.tapOn({ point: `${middle.x},${middle.y}` })
        await sleep(300)
      }
      return (await nodes()).find(node => isControl(node, id))
    }
    const press = async (want: string): Promise<void> => {
      const button = await control('Play/Pause')
      assert(button?.bounds != null, 'the player has Play/Pause')
      if (button.text !== want) return
      const at = centre(button.bounds)
      say(`$ tapOn ${want}`)
      await m.tapOn({ point: `${at.x},${at.y}` })
    }
    await press('Play')
    const elapsed = async (): Promise<string> =>
      (await control('Elapsed Time'))?.text ?? ''
    const startedAt = await elapsed()
    const clips = artifacts ?? tmpdir()
    const playing = path.join(clips, 'e11-step6-playing.mp4')
    if (webcam != null) {
      say('$ ffmpeg webcam 6 s (playing)')
      await filmPhone(playing, 6)
    } else await sleep(5000)
    const laterAt = await elapsed()
    assert(
      elapsedSeconds(laterAt) > elapsedSeconds(startedAt),
      `the video plays: elapsed ${startedAt} → ${laterAt}`
    )
    const volume = (await find(node => isControl(node, 'Mute/Unmute'), 1000))
      ?.text
    if (webcam == null) {
      results.push(
        `6 the game's finished video “${finishedName}” (${finished.id}) plays: elapsed “${startedAt}” → “${laterAt}”, volume button “${volume ?? '?'}”`
      )
    } else {
      await press('Pause')
      await sleep(1000)
      const quiet = path.join(clips, 'e11-step6-paused.mp4')
      say('$ ffmpeg webcam 4 s (paused)')
      await filmPhone(quiet, 4)
      const frame = path.join(clips, 'e11-step6-playback-webcam.png')
      await run('ffmpeg', [
        '-nostdin',
        '-loglevel',
        'error',
        '-ss',
        '3',
        '-i',
        playing,
        '-frames:v',
        '1',
        '-y',
        frame
      ])
      const loud = await meanVolume(playing)
      const still = await meanVolume(quiet)
      say(
        `$ ffmpeg volumedetect: webcam sound ${loud} dB playing, ${still} dB paused`
      )
      assert(
        loud >= still + 6,
        `the room hears the video: ${loud} dB playing, ${still} dB paused`
      )
      results.push(
        `6 the game's finished video “${finishedName}” (${finished.id}) plays with sound: elapsed “${startedAt}” → “${laterAt}”, volume button “${volume ?? '?'}”; webcam sound ${loud} dB playing, ${still} dB paused; frame ${path.basename(frame)}`
      )
    }
  } finally {
    if (outageIp != null) await shape([{ ip: outageIp }]).catch(() => {})
    await m.detach()
  }
  for (const line of results) say(`PASS ${line}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
