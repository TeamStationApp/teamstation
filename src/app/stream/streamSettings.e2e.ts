// E13: the streaming screen's settings sheet may stand upright or lie
// sideways, has only
// the phone's own settings, turns the microphone off on the live stream and
// renames the angle. Through maestro-d's JavaScript client, on an iOS
// simulator or an iPhone, or on an Android phone with TS_STREAM_ANDROID_SERIAL
// in place of the UDID.
//
//   TS_STREAM_IOS_UDID=<device> | TS_STREAM_ANDROID_SERIAL=<adb serial> \
//   MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   [TS_STREAM_TEAM_ID=<WebDriverAgent signing team, for a real device>] \
//   TS_STREAM_API=http://<address>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_HLS_ROOT=<the server's media directory>/work/videos \
//   TS_STREAM_EMAIL=<a seeded user who may film> \
//   TS_STREAM_GAME=<a game with another video, so it shows angle pills> \
//   [TS_STREAM_ANGLE=Second Base] [TS_STREAM_RENAME=Third Base] \
//   [TS_STREAM_TOKEN=<session>] [TS_STREAM_ARTIFACT_DIR=<dir>] \
//   [TS_STREAM_HOLD=LANDSCAPE_LEFT|LANDSCAPE_RIGHT] \
//     node -r sucrase/register src/app/stream/streamSettings.e2e.ts
//
// WebDriverAgent's orientation stands in for a real phone's own while it
// runs. The camera stays landscape either way the phone is turned. Settings
// follows the phone, upright or sideways. On a phone, TS_STREAM_HOLD says
// which way up the phone is held, and is set once the streaming screen is up.
//
// The local server runs without mail, so it logs each sign-in link; the app
// is signed in through its own `teamstation://signin/` link. This person's
// streams on the game named either angle are removed first, so the rename is
// not refused by an earlier run's camera.
//
//   1. Record video → the angle's name → Start; Record → "Broadcasting", and
//      the live HLS carries the microphone (volumedetect).
//   2. The gear: a screenshot in landscape (two columns). Turned upright, the
//      sheet stands upright (one column), then lies sideways again.
//   3. assertNotVisible Bitrate, Codec, Resolution, Clean HDMI, Identifier and
//      Log in.
//   4. Toggle a lens (a camera with one lens, such as the simulator's, has
//      none to toggle).
//   5. Turn the microphone off, rename the angle, Done: the badge reads the
//      new name, and the live HLS goes silent (max_volume ≤ −80 dB).
//   6. Slide to Stop, Close: the game's angle pill reads the new name.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
  stopApp: (options: { appId: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (
    target: { text: string } | { id: string } | { point: string }
  ) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  eraseText: (options: { characters: number }) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  assertNotVisible: (options: { text: string }) => Promise<unknown>
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
  detach: () => Promise<unknown>
}
interface Daemon {
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
const angle = process.env.TS_STREAM_ANGLE ?? 'Second Base'
const renamed = process.env.TS_STREAM_RENAME ?? 'Third Base'
const teamId = process.env.TS_STREAM_TEAM_ID
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const hold = process.env.TS_STREAM_HOLD
const APP = 'app.teamstation.app'
/** Cameraman's settings that the phone's sheet must not have. */
const ABSENT = [
  'Bitrate',
  'Codec',
  'Resolution',
  'Clean HDMI',
  'Identifier',
  'Log in'
]
/** Digital silence reads −91 dB; anything at or under this is silent. */
const SILENT_DB = -80

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
}

async function myStreams(token: string): Promise<StreamRow[]> {
  const answer = await request(
    'GET',
    `/games/${game}/live-streams`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the game’s cameras were listed')
  return ((await answer.json()) as { mine: StreamRow[] }).mine
}

const named = (row: StreamRow, name: string): boolean =>
  row.label.toLowerCase() === name.toLowerCase()

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

/** The loudest sample in the live HLS's last two segments, in dB. */
async function loudest(file: string): Promise<number> {
  const { stderr } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-live_start_index',
      '-2',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-t',
      '6',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-'
    ],
    { timeout: 60000 }
  )
  const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr)
  assert(match != null, `volumedetect said nothing: ${stderr.slice(-400)}`)
  return match[1] === '-inf' ? -Infinity : Number(match[1])
}

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
    return (
      (await nodes())
        .map(node => node.text)
        .find(text => words.includes(text ?? '')) ?? '?'
    )
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
  const layout = async (): Promise<string | undefined> =>
    (
      await find(
        node =>
          node.id === 'settings-layout-landscape' ||
          node.id === 'settings-layout-portrait',
        8000
      )
    )?.id

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
    for (const row of await myStreams(token)) {
      if (!named(row, angle) && !named(row, renamed)) continue
      say(`$ DELETE …/live-streams/${row.id} (${row.label}, an earlier run’s)`)
      const removed = await request(
        'DELETE',
        `/games/${game}/live-streams/${row.id}`,
        undefined,
        token
      )
      assert(removed.ok, `removing ${row.id}: ${removed.status}`)
    }

    // 1. The streaming screen, live.
    say(`$ openLink teamstation://games/${game}?tab=watch`)
    await m.openLink({ link: `teamstation://games/${game}?tab=watch` })
    await sleep(3000)
    if (android) {
      // maestro-d's scroll swipes across the middle of the screen, which on
      // Android is the game's video player, and the player keeps the swipe:
      // swipe below it instead (the hierarchy holds only what is on screen).
      const below = async (): Promise<boolean> => {
        // Off screen, or reaching down to where the floating tab bar starts.
        const bounds = (await find(byText('Record video'), 1000))?.bounds
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
      say('$ scrollUntilVisible Record video')
      await m.scrollUntilVisible({
        element: { text: 'Record video' },
        centerElement: true
      })
    }
    say('$ tapOn Record video')
    const recordVideo = android
      ? await find(byText('Record video'), 3000)
      : undefined
    if (recordVideo?.bounds != null) {
      // In the middle: the watch tab leaves room under its last row for the
      // floating tab bar, so the whole button is clear of it.
      const { x, y, width, height } = recordVideo.bounds
      await m.tapOn({
        point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
      })
    } else {
      await m.tapOn({ text: 'Record video' })
    }
    assert(
      (await find(byText('Name this camera angle'))) != null,
      'Record video asks for the angle’s name'
    )
    say(`$ inputText ${angle}`)
    await m.inputText({ text: angle })
    say('$ tapOn Start')
    await m.tapOn({ text: 'Start' })
    assert(
      (await find(byId('broadcast-button'), 20000)) != null,
      'the streaming screen opened'
    )
    if (hold != null) {
      say(`$ setOrientation ${hold}`)
      // WebDriverAgent refuses to turn to the orientation it already holds.
      await m.setOrientation(hold).catch((error: unknown) => {
        say(`setOrientation ${hold}: ${String(error).split('\n')[0]}`)
      })
    }
    await sleep(1500)
    say('$ tapOn broadcast-button')
    await m.tapOn({ id: 'broadcast-button' })
    const toLive = await waitForPill('Broadcasting', 45000)
    const row = (await myStreams(token)).find(one => named(one, angle))
    assert(row?.videoId != null, 'the stream has a live video')
    const videoId = row.videoId
    let hls = await playlist(videoId)
    for (
      const until = Date.now() + 30000;
      hls.segments < 3 && Date.now() < until;
    ) {
      await sleep(1000)
      hls = await playlist(videoId)
    }
    assert(hls.segments >= 3, 'the live HLS has segments')
    const before = await loudest(hls.file)
    say(`$ ffmpeg volumedetect (microphone on): max_volume ${before} dB`)
    assert(before > SILENT_DB, 'the live HLS carries sound before')
    results.push(
      `1 Broadcasting after ${toLive.toFixed(1)} s; live HLS max_volume ${before} dB with the microphone on`
    )

    // 2. The gear follows the phone: two columns sideways, one column upright.
    say('$ tapOn settings-button')
    await m.tapOn({ id: 'settings-button' })
    assert(
      (await find(byId('settings-done'), 10000)) != null,
      'the gear opened the settings sheet'
    )
    await sleep(1000)
    const sideways = await layout()
    assert.equal(sideways, 'settings-layout-landscape', 'two columns sideways')
    await shot('stream-settings-landscape.png')
    say('$ setOrientation PORTRAIT')
    await m.setOrientation('PORTRAIT')
    await sleep(2500)
    const upright = await layout()
    assert.equal(
      upright,
      'settings-layout-portrait',
      'the sheet stands upright when portrait is requested'
    )
    await shot('stream-settings-portrait.png')
    say(`$ setOrientation ${hold ?? 'LANDSCAPE_LEFT'}`)
    await m.setOrientation(hold ?? 'LANDSCAPE_LEFT')
    await sleep(2500)
    assert.equal(await layout(), 'settings-layout-landscape')
    results.push(
      '2 the gear opened the sheet, stood it upright, then laid it sideways again'
    )

    // 3. None of Cameraman's other settings.
    for (const text of ABSENT) {
      say(`$ assertNotVisible ${text}`)
      await m.assertNotVisible({ text })
    }
    results.push(`3 not shown: ${ABSENT.join(', ')}`)

    // 4. A lens.
    const lenses = (await nodes()).filter(
      node => node.id?.startsWith('settings-lens-') === true
    )
    if (lenses.length > 1) {
      const last = lenses[lenses.length - 1]
      say(`$ tapOn ${last.id ?? ''}`)
      await m.tapOn({ id: last.id ?? '' })
      results.push(`4 toggled ${last.id ?? ''} of ${lenses.length} lenses`)
    } else {
      const note = await textOf('settings-lenses-card')
      results.push(
        `4 no lens to toggle: ${lenses.length} lens listed${note == null ? '' : ` (“${note}”)`}`
      )
    }

    // 5. Microphone off, the new name, Done.
    say('$ tapOn settings-audio')
    await m.tapOn({ id: 'settings-audio' })
    say('$ tapOn settings-name')
    await m.tapOn({ id: 'settings-name' })
    if (android) {
      // Sideways, Android edits the field in the keyboard's full-screen
      // editor. UIAutomator2's text goes into that editor only and never
      // reaches the app's field, so type through the keyboard instead, and
      // Enter commits and closes the editor.
      await sleep(800)
      say(
        `$ adb shell input keyevent MOVE_END, DEL x${angle.length + 4}; input text ${renamed}`
      )
      await run('adb', ['-s', device, 'shell', 'input', 'keyevent', '123'])
      await run('adb', [
        '-s',
        device,
        'shell',
        'input',
        'keyevent',
        ...Array<string>(angle.length + 4).fill('67')
      ])
      await run('adb', [
        '-s',
        device,
        'shell',
        'input',
        'text',
        renamed.replace(/ /g, '%s')
      ])
      await sleep(500)
      say('$ adb shell input keyevent KEYCODE_ENTER')
      await run('adb', ['-s', device, 'shell', 'input', 'keyevent', '66'])
      await sleep(1000)
    } else {
      await m.eraseText({ characters: angle.length + 10 })
      say(`$ inputText ${renamed}`)
      await m.inputText({ text: renamed })
      await m.hideKeyboard().catch(() => {})
    }
    say('$ tapOn settings-done')
    await m.tapOn({ id: 'settings-done' })
    const doneAt = Date.now()
    for (const until = Date.now() + 10000; Date.now() < until;) {
      if ((await find(byId('settings-done'), 0)) == null) break
      await sleep(400)
    }
    assert(
      (await find(byId('settings-done'), 0)) == null,
      'Done closed the sheet'
    )
    const badge = await textOf('camera-name')
    assert.equal(badge, renamed, 'the badge reads the new name')
    const server = (await myStreams(token)).find(one => one.id === row.id)
    assert.equal(server?.label, renamed, 'the server has the new name')
    // Segments are 4 s: wait for three cut after Done.
    const atDone = (await playlist(videoId)).segments
    for (
      const until = Date.now() + 40000;
      (await playlist(videoId)).segments < atDone + 3 && Date.now() < until;
    )
      await sleep(1000)
    const after = await loudest(hls.file)
    say(`$ ffmpeg volumedetect (microphone off): max_volume ${after} dB`)
    assert(after <= SILENT_DB, 'the live HLS is silent with the microphone off')
    results.push(
      `5 Done after ${((Date.now() - doneAt) / 1000).toFixed(0)} s wait: badge “${badge}”, server label “${server?.label ?? '?'}”; live HLS max_volume ${after} dB with the microphone off`
    )

    // 6. Stop, Close, and the game's angle pill.
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
    await waitForPill('Press record to start stream', 20000)
    say('$ tapOn camera-close')
    await m.tapOn({ id: 'camera-close' })
    assert(
      // Android lists only what is on the screen, and Record video may be below it.
      (await find(
        node =>
          node.text === 'Record video' ||
          (android && node.text === 'Box score'),
        10000
      )) != null,
      'Close goes back to the game'
    )
    // The game's videos are read when its screen mounts: start the app again
    // and open the game afresh. On a phone, launchApp's stopApp only brings a
    // running app forward, so stop it first.
    say('$ stopApp')
    await m.stopApp({ appId: APP })
    say('$ launchApp')
    await m.launchApp({ appId: APP, stopApp: true })
    await sleep(3000)
    say(`$ openLink teamstation://games/${game}?tab=watch`)
    await m.openLink({ link: `teamstation://games/${game}?tab=watch` })
    const angleTab = await find(byText(renamed), 15000)
    assert(angleTab?.bounds != null, 'the game’s angle pill reads the new name')
    // The strip scrolls sideways: bring the pill into view.
    const width = (await m.hierarchy()).bounds?.width ?? 390
    for (let swipes = 0; swipes < 6; swipes += 1) {
      const pillNow = await find(byText(renamed), 2000)
      if (pillNow?.bounds == null) break
      const middle = centre(pillNow.bounds)
      if (middle.x > 0 && middle.x < width) break
      say('$ swipe the angle strip left')
      await m.swipe({
        startX: Math.round(width * 0.8),
        startY: middle.y,
        endX: Math.round(width * 0.2),
        endY: middle.y,
        duration: 400
      })
      await sleep(600)
    }
    await shot('stream-settings-renamed-pill.png')
    const gameAnswer = await request('GET', `/games/${game}`, undefined, token)
    const titles = (
      (await gameAnswer.json()) as { videos?: Array<{ title: string }> }
    ).videos?.map(video => video.title)
    results.push(
      `6 stopped and closed; the game shows an angle pill “${angleTab.text ?? ''}”; the game’s video titles include ${JSON.stringify(titles?.filter(title => title.endsWith(renamed)))}`
    )
  } finally {
    await m.detach()
  }
  for (const line of results) say(`PASS ${line}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
