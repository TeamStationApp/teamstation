// E11 and E12: Record video opens the streaming screen with the Cameraman
// overlay, records and streams, and rides out an outage on a real phone.
// Through maestro-d's JavaScript client, on an iOS simulator or an iPhone.
//
//   TS_STREAM_IOS_UDID=<device> MAESTRO_D=<this agent's daemon> \
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
//   [TS_STREAM_WEBCAM_URL=<an RTSP(S) camera watching the phone, with sound>] \
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
//   1. Record video → the angle's name → Start.
//   2. The overlay: the name, "Press record to start stream", a thermal
//      label, and on a phone the battery. Screenshot.
//   3. Record → "Broadcasting"; ffprobe the live HLS (HEVC 1080p).
//   4. Pinch, and read the zoom readout again.
//   E12, with TS_STREAM_OUTAGE_IP: the phone's address loses every packet for
//      20 s, then is capped at 1 Mbit/s for 60 s. The pill is read throughout,
//      the HLS is watched for the stream coming back, and the ingest's rate is
//      sampled under the cap.
//   5. Slide to Stop: the blue pill returns and the server hears that this
//      phone holds the recording. Close.
//   6. Back on the Videos tab, the game's video plays: the player's elapsed
//      time moves. With TS_STREAM_WEBCAM_URL, the camera's frame is kept and
//      its sound must be louder while the video plays than once it is paused,
//      so the game should have a video with sound in its player.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

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
    platform: 'ios'
    appId: string
    teamId?: string
  }) => Promise<Driver>
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const device = required('TS_STREAM_IOS_UDID')
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
  status: { ingress: { publishing: boolean; bytesPerSecond: number } } | null
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
    platform: 'ios',
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

    // 1. Record video, the prompt, Start.
    say(`$ openLink teamstation://games/${game}`)
    await m.openLink({ link: `teamstation://games/${game}` })
    await sleep(3000)
    say('$ scrollUntilVisible Record video')
    await m.scrollUntilVisible({
      element: { text: 'Record video' },
      centerElement: true
    })
    say('$ tapOn Record video')
    await m.tapOn({ text: 'Record video' })
    assert(
      (await find(byText('Name this camera angle'))) != null,
      'Record video asks for the angle’s name'
    )
    await shot('angle-name-prompt')
    say(`$ inputText ${angle}`)
    await m.inputText({ text: angle })
    say('$ tapOn Start')
    await m.tapOn({ text: 'Start' })
    const badge = await find(
      node => node.id === 'camera-name' || node.text === angle,
      20000
    )
    assert(
      badge != null && (await find(byId('broadcast-button'), 10000)) != null,
      'the streaming screen opened'
    )
    results.push(
      `1 Record video → “${angle}” → Start opened the streaming screen`
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
    const isSimulator = /^[0-9A-F]{8}-[0-9A-F]{4}-/.test(device)
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
    say('$ tapOn slide-to-stop-dismiss')
    await m.tapOn({ id: 'slide-to-stop-dismiss' })

    // 4. Pinch out from the middle of the picture, with two fingers.
    const before = await textOf('zoom-label')
    const port = (
      await readFile(path.join(daemon.info.runDir, 'daemon.log'), 'utf8')
    )
      .split('\n')
      .filter(line => line.includes(`Starting WDA on device ${device} (port:`))
      .at(-1)
      ?.match(/\(port: (\d+)\)/)?.[1]
    assert(
      port != null,
      'this device’s WebDriverAgent port is in the daemon log'
    )
    const wda = `http://127.0.0.1:${port}`
    const status = await m.eval(`http.get(${JSON.stringify(`${wda}/status`)})`)
    const { sessionId } = JSON.parse(status.body) as { sessionId: string }
    const screen = (await m.hierarchy()).bounds ?? {
      x: 0,
      y: 0,
      width: 844,
      height: 390
    }
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
    const pinched = await m.eval(
      `http.post(${JSON.stringify(`${wda}/session/${sessionId}/actions`)}, {body:${JSON.stringify(
        JSON.stringify({ actions: [finger('left', -1), finger('right', 1)] })
      )}})`
    )
    assert.equal(pinched.status, 200, pinched.body)
    await sleep(1500)
    const after = await textOf('zoom-label')
    results.push(
      `4 pinch: zoom readout ${before ?? '?'} → ${after ?? '?'}${before === after ? ' (unchanged)' : ''}`
    )

    // E12: the outage.
    if (outageIp != null) {
      // The writer for the new connection appends after a discontinuity; the
      // segment the old writer flushes as its stream ends does not count.
      const joins = async (): Promise<{ joins: number; after: number }> => {
        const text = await readFile(
          (await playlist(row.videoId!)).file,
          'utf8'
        ).catch(() => '')
        const parts = text.split('#EXT-X-DISCONTINUITY')
        return {
          joins: parts.length - 1,
          after: (parts.at(-1) ?? '')
            .split('\n')
            .filter(line => line.startsWith('#EXTINF')).length
        }
      }
      const cutAt = new Date()
      say(`cut: 100% loss on the phone for 20 s`)
      await shape([{ ip: outageIp, lossPct: 100 }])
      const seen = new Set<string>()
      for (const until = Date.now() + 20000; Date.now() < until;) {
        seen.add(await pill())
        await sleep(1000)
      }
      const joinsAtRestore = (await joins()).joins
      await shape([{ ip: outageIp }])
      const restoredAt = Date.now()
      say(`restored; the pill read ${[...seen].join(', ')} during the cut`)
      let resumed: number | undefined
      let publishing: number | undefined
      for (
        const until = restoredAt + 60000;
        Date.now() < until && (resumed == null || publishing == null);
      ) {
        if (
          publishing == null &&
          (await myStream(token)).status?.ingress.publishing === true
        ) {
          // The ingest's view lags a little; the pill says when the phone is through.
          if ((await pill()) === 'Broadcasting')
            publishing = (Date.now() - restoredAt) / 1000
        }
        const now = await joins()
        if (resumed == null && now.joins > joinsAtRestore && now.after > 0)
          resumed = (Date.now() - restoredAt) / 1000
        await sleep(500)
      }
      const pillAfter = await pill()
      results.push(
        `E12 cut ${cutAt.toISOString()}: pill during the cut ${[...seen].join(' → ')}; after the restore ${pillAfter} at ${publishing?.toFixed(1) ?? 'never'} s; first segment of the new connection in the HLS ${resumed?.toFixed(1) ?? 'never'} s after the restore`
      )
      await writeFile(
        path.join(artifacts ?? '.', 'e12-times.json'),
        JSON.stringify({
          cutAt: cutAt.toISOString(),
          restoredAt: new Date(restoredAt).toISOString(),
          videoId: row.videoId,
          playlist: (await playlist(row.videoId)).file
        })
      )
      say('throttle: 1 Mbit/s for 60 s')
      await shape([{ ip: outageIp, mbit: 1 }])
      const rates: number[] = []
      const pills = new Set<string>()
      for (const until = Date.now() + 60000; Date.now() < until;) {
        await sleep(5000)
        const sample = await myStream(token)
        rates.push(((sample.status?.ingress.bytesPerSecond ?? 0) * 8) / 1e6)
        pills.add(await pill())
      }
      await shape([{ ip: outageIp }])
      const settled = rates.slice(-6)
      const mean =
        settled.reduce((sum, value) => sum + value, 0) /
        Math.max(settled.length, 1)
      say(
        `ingest Mbit/s every 5 s under the cap: ${rates.map(rate => rate.toFixed(2)).join(' ')}`
      )
      results.push(
        `E12 throttle 1 Mbit/s: ingest ${rates.map(rate => rate.toFixed(2)).join(' ')} Mbit/s; last 30 s mean ${mean.toFixed(2)}; pill ${[...pills].join(', ')}`
      )
      await sleep(10000)
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
    say('$ tapOn camera-close')
    await m.tapOn({ id: 'camera-close' })
    assert(
      (await find(byText('Record video'), 10000)) != null,
      'Close goes back to the game'
    )
    const recordingStat = await stat(hls.file)
    results.push(
      `5 closed; the live HLS playlist last written ${recordingStat.mtime.toISOString()}`
    )

    // 6. The game's video plays, with sound, now the camera has let go.
    const player = await find(
      node => node.id === 'Video' || node.text === 'Video',
      10000
    )
    assert(player?.bounds != null, 'the Videos tab has a player')
    // With its controls hidden, a tap on the player only shows them (they
    // hide again after a few seconds of playback); read them at once.
    const middle = centre(player.bounds)
    const control = async (id: string): Promise<Node | undefined> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const shown = (await nodes()).find(
          node => node.id === id && node.bounds != null
        )
        if (shown != null) return shown
        say('$ tapOn the player (shows its controls)')
        await m.tapOn({ point: `${middle.x},${middle.y}` })
        await sleep(300)
      }
      return (await nodes()).find(node => node.id === id)
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
    const volume = (await find(byId('Mute/Unmute'), 1000))?.text
    if (webcam == null) {
      results.push(
        `6 the game's video plays: elapsed “${startedAt}” → “${laterAt}”, volume button “${volume ?? '?'}”`
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
        `6 the game's video plays with sound: elapsed “${startedAt}” → “${laterAt}”, volume button “${volume ?? '?'}”; webcam sound ${loud} dB playing, ${still} dB paused; frame ${path.basename(frame)}`
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
