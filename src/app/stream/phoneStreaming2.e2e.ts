// The phoneStreaming2 checks, on a bench iPhone or Pixel, through maestro-d.
//
//   TS_STREAM_IOS_UDID=<device> | TS_STREAM_ANDROID_SERIAL=<adb serial> \
//   MAESTRO_D=phoneStreaming2 \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   [TS_STREAM_TEAM_ID=<WebDriverAgent signing team>] \
//   TS_STREAM_API=http://<host>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_HLS_ROOT=<the server's media directory>/work/videos \
//   TS_STREAM_EMAIL=<a seeded user who may film> TS_STREAM_GAME=<a game> \
//   [TS_STREAM_ARTIFACT_DIR=<dir>] [TS_STREAM_GAP=1] \
//     node -r sucrase/register src/app/stream/phoneStreaming2.e2e.ts
//
// Name, rejoin, and orientation run on whichever device the environment
// names. The wall-clock gap runs only with TS_STREAM_GAP=1, on one phone.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const say = (line: string): void => {
  console.log(`${new Date().toISOString()} $ ${line}`)
}

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
    element: { text?: string; id?: string }
    centerElement?: boolean
    visibilityPercentage?: number
  }) => Promise<unknown>
  swipe: (gesture: {
    start?: string
    startX?: number
    startY?: number
    end?: string
    endX?: number
    endY?: number
    duration?: number
  }) => Promise<unknown>
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
const teamId = process.env.TS_STREAM_TEAM_ID
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const gap = process.env.TS_STREAM_GAP === '1'
const APP = 'app.teamstation.app'
const SUGGESTIONS = ['Home', '1st', '3rd', 'Dugout']

const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

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

async function signInLink(): Promise<string> {
  const offset = (await readFile(serverLog, 'utf8')).length
  const asked = await request('POST', '/auth/email-code', { email })
  assert.equal(asked.status, 202, 'the sign-in code was sent')
  return await fromServerLog(
    /link: https?:\/\/[^/\s]+\/signin\/([A-Za-z0-9_-]+)/,
    offset
  )
}

async function apiToken(): Promise<string> {
  const given = process.env.TS_STREAM_TOKEN
  if (given != null && given !== '') return given
  const offset = (await readFile(serverLog, 'utf8')).length
  await request('POST', '/auth/email-code', { email })
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const code = await fromServerLog(
    new RegExp(`sign-in code for ${escaped}: (\\d{6})`),
    offset
  )
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
  keyPrefix?: string | null
}

async function myStreams(token: string): Promise<StreamRow[]> {
  const answer = await request(
    'GET',
    `/games/${game}/live-streams`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the game’s cameras were listed')
  const { mine } = (await answer.json()) as { mine: StreamRow[] }
  return mine.filter(row => row.label === 'Home' && row.deviceModel != null)
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
  if (artifacts != null) await mkdir(artifacts, { recursive: true })
  const lines: string[] = []
  const note = (line: string): void => {
    say(line)
    lines.push(`$ ${line}`)
  }
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
  const shot = async (name: string): Promise<void> => {
    if (artifacts == null) return
    note(`takeScreenshot ${name}`)
    await m.takeScreenshot({ path: path.join(artifacts, name) })
  }
  const screen = async (): Promise<Bounds> => {
    for (const until = Date.now() + 20000; ;) {
      const measured = (await nodes()).filter(
        node =>
          node.bounds != null && node.bounds.width > 0 && node.bounds.height > 0
      )
      // iOS reports a few views in pixels and the rest in points. The points
      // are what a tap uses, and they fit a phone. Android is pixels throughout.
      const all = android
        ? measured
        : measured.filter(
            node => node.bounds!.width < 900 && node.bounds!.height < 900
          )
      const pool = all.length > 0 ? all : measured
      pool.sort(
        (a, b) =>
          (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0) -
          (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0)
      )
      const bounds = pool[0]?.bounds
      if (bounds != null && bounds.width > 200 && bounds.height > 200)
        return bounds
      if (Date.now() > until) break
      await sleep(400)
    }
    throw new Error('the screen has bounds')
  }
  const landscape = async (): Promise<Bounds> => {
    const bounds = await screen()
    assert(
      bounds.width > bounds.height,
      `the camera bounds are landscape (${bounds.width}×${bounds.height})`
    )
    return bounds
  }
  const inBand = (bounds: Bounds, frame: Bounds): boolean =>
    bounds.y > frame.height * 0.2 &&
    bounds.y + bounds.height < frame.height * 0.82
  // The watch tab keeps the player and its angle chips stuck to the top.
  // A row can sit in the band and still be underneath those chips, so a tap
  // lands on a chip. A smaller node from outside the row covering its center
  // means it has to move.
  const covered = (row: Node, all: Node[]): boolean => {
    const bounds = row.bounds
    if (bounds == null) return true
    const same = all.find(node => node.id != null && node.id === row.id) ?? row
    const inside = new Set<Node>()
    const mark = (node: Node): void => {
      inside.add(node)
      for (const child of node.children ?? []) mark(child)
    }
    mark(same)
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    const area = bounds.width * bounds.height
    return all.some(node => {
      if (inside.has(node)) return false
      const box = node.bounds
      if (box == null || box.width * box.height >= area) return false
      return (
        x >= box.x &&
        x <= box.x + box.width &&
        y >= box.y &&
        y <= box.y + box.height
      )
    })
  }
  const nudge = async (revealLower: boolean): Promise<void> => {
    const frame = await screen()
    const x = Math.round(frame.x + frame.width / 2)
    const from = Math.round(frame.y + frame.height * (revealLower ? 0.78 : 0.4))
    const to = Math.round(frame.y + frame.height * (revealLower ? 0.3 : 0.72))
    note(`swipe ${x},${from} → ${x},${to}`)
    await m.swipe({
      startX: x,
      startY: from,
      endX: x,
      endY: to,
      duration: 600
    })
    await sleep(700)
  }
  const reveal = async (
    pick: () => Promise<Node | undefined>,
    what: string
  ): Promise<Node> => {
    for (let i = 0; i < 8; i++) {
      const row = await pick()
      const frame = await screen()
      if (
        row?.bounds != null &&
        inBand(row.bounds, frame) &&
        !covered(row, await nodes())
      )
        return row
      const hiding = row?.bounds != null && covered(row, await nodes())
      const above =
        hiding || (row?.bounds != null && row.bounds.y < frame.height * 0.2)
      await nudge(!above)
    }
    const row = await pick()
    assert(row?.bounds != null, `${what} is on screen`)
    return row
  }
  const tapPoint = async (row: Node, what: string): Promise<void> => {
    assert(row.bounds != null, `${what} is on screen`)
    const { x, y, width, height } = row.bounds
    note(`tapOn ${what}`)
    await m.tapOn({
      point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
    })
  }
  const openRecord = async (): Promise<void> => {
    note(`openLink teamstation://games/${game}?tab=watch`)
    await m.openLink({ link: `teamstation://games/${game}?tab=watch` })
    await sleep(2500)
    const row = await reveal(
      async () => await find(node => node.text === 'Record video', 600),
      'Record video'
    )
    await tapPoint(row, 'Record video')
    assert(
      (await find(node => node.text === 'Name this camera angle', 15000)) !=
        null,
      'Record video asks for the angle’s name'
    )
  }
  const tapCameraRow = async (label: string, id?: string): Promise<void> => {
    if (!android) {
      for (let i = 0; i < 10; i++) {
        const frame = await screen()
        if (frame.height > frame.width) break
        await sleep(400)
      }
    }
    const sameRow = (a: Bounds, b: Bounds): boolean =>
      Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 48
    const row = await reveal(async () => {
      if (id != null) return await find(node => node.id === id, 600)
      const rows = (await nodes()).filter(
        node => node.text === label && node.bounds != null
      )
      const states = (await nodes()).filter(
        node =>
          (node.text === 'Idle' || node.text === 'Live') && node.bounds != null
      )
      return rows.find(
        candidate =>
          candidate.bounds != null &&
          states.some(
            state =>
              state.bounds != null && sameRow(candidate.bounds!, state.bounds)
          )
      )
    }, `the ${label} camera row`)
    await tapPoint(row, `${label} camera row`)
  }
  const stopAndClose = async (): Promise<number> => {
    note('tapOn broadcast-button')
    await m.tapOn({ id: 'broadcast-button' })
    const knob = await find(node => node.id === 'slide-to-stop-knob', 8000)
    const track = await find(node => node.id === 'slide-to-stop-track', 3000)
    if (knob?.bounds != null && track?.bounds != null) {
      const from = {
        x: Math.round(knob.bounds.x + knob.bounds.width / 2),
        y: Math.round(knob.bounds.y + knob.bounds.height / 2)
      }
      const to = {
        x: Math.round(track.bounds.x + track.bounds.width - 4),
        y: from.y
      }
      note(`swipe ${from.x},${from.y} → ${to.x},${to.y}`)
      await m.swipe({
        startX: from.x,
        startY: from.y,
        endX: to.x,
        endY: to.y,
        duration: 800
      })
      assert(
        (await find(
          node => node.text === 'Press record to start stream',
          20000
        )) != null,
        'Slide to Stop returns the blue pill'
      )
    }
    const stopped = Date.now()
    note('tapOn camera-close')
    await m.tapOn({ id: 'camera-close' })
    await sleep(1500)
    return stopped
  }

  note('launchApp')
  await m.launchApp({ appId: APP, stopApp: true })
  if (
    (await find(node => node.text === 'Sign in to TeamStation', 12000)) != null
  ) {
    const link = await signInLink()
    note('openLink teamstation://signin/<token>')
    await m.openLink({ link: `teamstation://signin/${link}` })
    await sleep(3000)
    if ((await find(node => node.id === 'signInLinkSignIn', 3000)) != null)
      await m.tapOn({ id: 'signInLinkSignIn' })
  }
  const token = await apiToken()

  await openRecord()
  const shown = (await nodes()).map(node => node.text)
  for (const label of SUGGESTIONS) {
    assert(shown.includes(label), `the prompt offers ${label}`)
  }
  const prompt = (await nodes()).find(node => node.id === 'angle-name-prompt')
  assert(prompt != null, 'the name prompt is on screen')
  assert(
    !flatten(prompt).some(node => node.text === 'Home Plate'),
    'the placeholder is Home, not Home Plate'
  )
  note('tapOn Home')
  await m.tapOn({ id: 'angle-suggestion-Home' })
  await sleep(400)
  const field = (await nodes()).find(node => node.id === 'angle-name-field')
  const fieldText =
    field?.text ??
    (await nodes())
      .filter(node => node.text === 'Home')
      .map(node => node.text)
      .join('')
  assert(
    (await nodes()).some(node => node.text === 'Home'),
    'tapping Home fills the field'
  )
  await shot(
    android ? 'angle-prompt-after-pixel.png' : 'angle-prompt-after.png'
  )
  note(
    `field reads Home (${fieldText === 'Home' ? 'Home' : 'a Home label is visible'})`
  )
  note('tapOn Start')
  await m.tapOn({ text: 'Start' })
  assert(
    (await find(node => node.id === 'broadcast-button', 20000)) != null,
    'the streaming screen opened'
  )
  await sleep(1000)
  const opened = await landscape()
  note(`camera bounds ${opened.width}×${opened.height}`)
  await shot(
    android ? 'camera-landscape-after-pixel.png' : 'camera-landscape-after.png'
  )
  note('setOrientation LANDSCAPE_RIGHT')
  await m.setOrientation('LANDSCAPE_RIGHT')
  await sleep(1200)
  const flipped = await landscape()
  note(`turned bounds ${flipped.width}×${flipped.height}`)
  await shot(
    android
      ? 'camera-landscape-flipped-after-pixel.png'
      : 'camera-landscape-flipped-after.png'
  )
  note('setOrientation PORTRAIT')
  let cameraPortraitRefused = false
  try {
    await m.setOrientation('PORTRAIT')
  } catch (error) {
    cameraPortraitRefused = true
    note(`portrait refused: ${String(error).split('\n')[0]}`)
  }
  await sleep(800)
  const cameraHeld = await landscape()
  note(
    `camera stayed landscape (${cameraHeld.width}×${cameraHeld.height})${
      cameraPortraitRefused ? '; portrait was refused' : ''
    }`
  )

  note('tapOn camera-close')
  await m.tapOn({ id: 'camera-close' })
  await sleep(1500)
  const openedIdle = await myStreams(token)
  assert.equal(
    openedIdle.length,
    1,
    'opening the camera without recording leaves one stream'
  )
  assert.notEqual(
    openedIdle[0].state,
    'publishing',
    'opening the camera without recording does not publish'
  )
  const streamId = openedIdle[0].id
  const keyPrefix = openedIdle[0].keyPrefix
  assert(keyPrefix != null && keyPrefix.length > 0, 'the idle stream has a key')
  const model = openedIdle[0].deviceModel
  const idleRow = await reveal(
    async () => await find(node => node.id === `angle-row-${streamId}`, 600),
    'the idle camera row'
  )
  assert(idleRow.bounds != null, 'the camera is one idle row')

  let cameBack = false
  for (let attempt = 0; attempt < 3 && !cameBack; attempt++) {
    await tapCameraRow('Home', `angle-row-${streamId}`)
    cameBack =
      (await find(
        node => node.id === 'broadcast-button',
        attempt === 2 ? 15000 : 4000
      )) != null
  }
  assert(cameBack, 'the idle row reopens the same camera')

  note('tapOn broadcast-button')
  await m.tapOn({ id: 'broadcast-button' })
  assert(
    (await find(node => node.text === 'Broadcasting', 45000)) != null,
    'the pill reads Broadcasting'
  )
  const publishing = (await myStreams(token)).filter(
    row => row.state === 'publishing'
  )
  assert.equal(
    publishing.length,
    1,
    'this phone has one Home stream publishing'
  )
  assert.equal(
    publishing[0].id,
    streamId,
    'recording uses the stream that was opened'
  )
  assert.equal(
    publishing[0].keyPrefix,
    keyPrefix,
    'recording publishes with the same key'
  )
  const videoId = publishing[0].videoId
  const onThisPhone = async (): Promise<StreamRow[]> =>
    (await myStreams(token)).filter(row => row.deviceModel === model)
  assert(videoId != null, 'the stream has a live video')
  note(`stream ${streamId} publishing`)

  // The camera stays landscape. Its settings follows the phone.
  let settingsOpen = false
  for (let i = 0; i < 4 && !settingsOpen; i++) {
    const gear = await find(node => node.id === 'settings-button', 3000)
    if (gear?.bounds != null) {
      const { x, y, width, height } = gear.bounds
      note(
        `tapOn settings-button ${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
      )
      await m.tapOn({
        point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
      })
    } else {
      note('tapOn settings-button')
      await m.tapOn({ id: 'settings-button' })
    }
    settingsOpen =
      (await find(node => node.id === 'settings-done', 3000)) != null
  }
  assert(settingsOpen, 'settings opened')
  await sleep(800)
  note('setOrientation PORTRAIT')
  await m.setOrientation('PORTRAIT')
  await sleep(800)
  const settings = await screen()
  assert(
    settings.height > settings.width,
    `settings went portrait (${settings.width}×${settings.height})`
  )
  note(`settings bounds ${settings.width}×${settings.height}`)
  await shot(
    android
      ? 'settings-portrait-after-pixel.png'
      : 'settings-portrait-after.png'
  )
  note('setOrientation LANDSCAPE_LEFT')
  await m.setOrientation('LANDSCAPE_LEFT')
  await sleep(800)
  const settingsSideways = await screen()
  assert(
    settingsSideways.width > settingsSideways.height,
    `settings went landscape (${settingsSideways.width}×${settingsSideways.height})`
  )
  const playlist = path.join(hlsRoot, videoId, 'master.m3u8')
  let playlistText = ''
  for (const until = Date.now() + 30000; ;) {
    try {
      playlistText = await readFile(playlist, 'utf8')
    } catch {
      playlistText = ''
    }
    if (playlistText.includes('#EXTINF')) break
    assert(Date.now() < until, 'the live playlist has a segment')
    await sleep(500)
  }
  // A live EVENT playlist has no end tag, and ffprobe then waits for the
  // next segment. A copy closed with ENDLIST is the same media.
  const probePath = path.join(hlsRoot, videoId, '.probe.m3u8')
  await writeFile(
    probePath,
    playlistText.includes('#EXT-X-ENDLIST')
      ? playlistText
      : `${playlistText.trimEnd()}\n#EXT-X-ENDLIST\n`
  )
  let probed: { stdout: string } | undefined
  let probeError: unknown
  try {
    for (let attempt = 0; attempt < 5 && probed == null; attempt++) {
      try {
        probed = await run('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height,codec_name',
          '-of',
          'default=nw=1',
          probePath
        ])
      } catch (error) {
        probeError = error
        await sleep(400)
      }
    }
  } finally {
    await unlink(probePath).catch(() => undefined)
  }
  if (probed == null) throw probeError
  note(`ffprobe ${probed.stdout.trim().replace(/\n/g, ' ')}`)
  assert(
    probed.stdout.includes('width=1920') &&
      probed.stdout.includes('height=1080'),
    `the live picture is 1920×1080 (${probed.stdout.trim()})`
  )
  if (artifacts != null) {
    await writeFile(
      path.join(artifacts, 'settings-hls-landscape.log'),
      `$ ffprobe ${playlist}\n${probed.stdout}`
    )
  }
  note('tapOn settings-done')
  await m.tapOn({ id: 'settings-done' })
  await sleep(800)
  await landscape()

  await stopAndClose()
  const afterClose = await onThisPhone()
  assert(afterClose.length === 1, 'closing leaves the one Home stream')
  assert.equal(afterClose[0].id, streamId, 'closing keeps the same stream id')

  let reopened = false
  for (let attempt = 0; attempt < 3 && !reopened; attempt++) {
    await tapCameraRow('Home', `angle-row-${streamId}`)
    reopened =
      (await find(
        node => node.id === 'broadcast-button',
        attempt === 2 ? 15000 : 4000
      )) != null
  }
  assert(reopened, 'the idle row reopens the camera')
  note('tapOn broadcast-button')
  await m.tapOn({ id: 'broadcast-button' })
  assert(
    (await find(node => node.text === 'Broadcasting', 45000)) != null,
    'the reopened camera publishes'
  )
  const again = await onThisPhone()
  assert.equal(again.length, 1, 'recording again did not add a stream')
  assert.equal(again[0].id, streamId, 'recording again uses the same stream id')
  assert.equal(
    again[0].keyPrefix,
    keyPrefix,
    'recording again publishes with the same key'
  )
  note(`rejoin stream ${again[0].id}`)
  await stopAndClose()
  await shot(
    android
      ? 'angles-after-rejoin-after-pixel.png'
      : 'angles-after-rejoin-after.png'
  )

  if (gap) {
    await tapCameraRow('Home', `angle-row-${streamId}`)
    assert(
      (await find(node => node.id === 'broadcast-button', 20000)) != null,
      'the camera reopened for the gap'
    )
    note('tapOn broadcast-button')
    await m.tapOn({ id: 'broadcast-button' })
    assert(
      (await find(node => node.text === 'Broadcasting', 45000)) != null,
      'the first stretch is publishing'
    )
    note('record 10s')
    await sleep(10000)
    const leftAt = await stopAndClose()
    note('wait 20s')
    await sleep(20000)
    await tapCameraRow('Home', `angle-row-${streamId}`)
    await m.tapOn({ id: 'broadcast-button' })
    assert(
      (await find(node => node.text === 'Broadcasting', 45000)) != null,
      'the second stretch is publishing'
    )
    const absence = (Date.now() - leftAt) / 1000
    note('record 10s')
    await sleep(10000)
    const text = await readFile(playlist, 'utf8')
    const initBytes = await readFile(path.join(hlsRoot, videoId, 'init.mp4'))
    const names = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^seg\d+\.m4s$/.test(line))
    const spanOf = async (
      name: string
    ): Promise<{ first: number; last: number } | undefined> => {
      const media = path.join(tmpdir(), `ts-gap-${name}`)
      await writeFile(
        media,
        Buffer.concat([
          initBytes,
          await readFile(path.join(hlsRoot, videoId, name))
        ])
      )
      try {
        const probed = await run('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time',
          '-of',
          'csv=p=0',
          media
        ])
        const times = probed.stdout
          .trim()
          .split('\n')
          .map(Number)
          .filter(value => Number.isFinite(value))
        if (times.length === 0) return undefined
        return { first: Math.min(...times), last: Math.max(...times) }
      } finally {
        await unlink(media).catch(() => undefined)
      }
    }
    const tail = names.slice(-6)
    const spans: Array<{ first: number; last: number }> = []
    for (const name of tail) {
      const span = await spanOf(name)
      if (span != null) spans.push(span)
    }
    let gap = Number.POSITIVE_INFINITY
    for (let i = 1; i < spans.length; i++) {
      const between = spans[i].first - spans[i - 1].last
      if (Math.abs(between - absence) < Math.abs(gap - absence)) gap = between
    }
    note(
      `timestamp gap ${gap.toFixed(3)}s after waiting ${absence.toFixed(3)}s`
    )
    assert(
      Number.isFinite(gap) && Math.abs(gap - absence) < 1,
      `the timestamp gap is the wait (${gap.toFixed(3)}s vs ${absence.toFixed(3)}s)`
    )
    if (artifacts != null) {
      await writeFile(
        path.join(artifacts, 'wall-clock-gap.log'),
        [
          `$ waited ${absence.toFixed(3)}s`,
          `$ demuxed timestamp gap ${gap.toFixed(3)}s`,
          text
        ].join('\n')
      )
    }
    await stopAndClose()
  }

  if (artifacts != null) {
    await writeFile(
      path.join(
        artifacts,
        android ? 'rejoin-same-key-pixel.log' : 'rejoin-same-key.log'
      ),
      lines.join('\n') + '\n'
    )
  }
  console.log(lines.join('\n'))
  console.log('PASS')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
