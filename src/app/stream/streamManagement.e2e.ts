// Stream management on a game's Videos tab, through maestro-d's JavaScript
// client, on Android phones.
//
//   TS_STREAM_ANDROID_SERIAL=<adb serial of the phone filming> \
//   TS_STREAM_VIEWER_SERIAL=<adb serial of the phone watching> \
//   MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   TS_STREAM_API=http://<LAN address>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_EMAIL=<a seeded user who may film> \
//   TS_STREAM_VIEWER_EMAIL=<a user who may see the game> \
//   TS_STREAM_GAME=<a game> [TS_STREAM_ANGLE=Backstop] \
//   [TS_STREAM_HOLD_SECONDS=45] [TS_STREAM_ARTIFACT_DIR=<dir>] \
//     node -r sucrase/register src/app/stream/streamManagement.e2e.ts
//
// The local server runs without mail, so it logs each sign-in link; the app
// is signed in through its own `teamstation://signin/` link. Both phones run a
// debug build, the only kind that reads `debug.ts.phone.start_floor`.
//
//   E2. The filming phone's start floor is set above its free space. Record
//   video → the angle's name → Start → record: the stream goes live with no
//   take, the camera screen says "Streaming only", and the server's list says
//   the phone keeps no recording. The viewer's phone plays the game. Stop, and
//   the server is told of no recording.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

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
  tapOn: (target: { text: string } | { id: string }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  swipe: (gesture: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration: number
  }) => Promise<unknown>
  scrollUntilVisible: (options: {
    element: { text: string } | { id: string }
    centerElement?: boolean
    timeout?: number
  }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: {
    device: string
    platform: 'android'
    appId: string
  }) => Promise<Driver>
}
interface Listed {
  id: string
  label: string
  state: string
  localRecording?: string
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const filming = required('TS_STREAM_ANDROID_SERIAL')
const watching = required('TS_STREAM_VIEWER_SERIAL')
const daemonName = required('MAESTRO_D')
const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
const api = required('TS_STREAM_API').replace(/\/$/, '')
const serverLog = required('TS_STREAM_SERVER_LOG')
const email = required('TS_STREAM_EMAIL')
const viewerEmail = required('TS_STREAM_VIEWER_EMAIL')
const game = required('TS_STREAM_GAME')
const angle = process.env.TS_STREAM_ANGLE ?? 'Backstop'
const holdSeconds = Number(process.env.TS_STREAM_HOLD_SECONDS ?? '45')
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const APP = 'app.teamstation.app'
const START_FLOOR_PROPERTY = 'debug.ts.phone.start_floor'
/** More than any phone on the bench holds, so Record finds it under the floor. */
const OVER_ANY_PHONE = '9000000000000'

const run = promisify(execFile)
const adb = async (serial: string, ...args: string[]): Promise<string> =>
  (await run('adb', ['-s', serial, ...args])).stdout
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
const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

async function askToSignIn(
  address: string
): Promise<{ code: string; link: string }> {
  const offset = (await readFile(serverLog, 'utf8')).length
  const asked = await request('POST', '/auth/email-code', { email: address })
  assert.equal(asked.status, 202, 'the sign-in code was sent')
  const code = await fromServerLog(
    new RegExp(`sign-in code for ${escape(address)}: (\\d{6})`),
    offset
  )
  const link = await fromServerLog(
    /link: https?:\/\/[^/\s]+\/signin\/([A-Za-z0-9_-]+)/,
    offset
  )
  return { code, link }
}

async function apiToken(address: string, code: string): Promise<string> {
  const verified = await request('POST', '/auth/email-code/verify', {
    email: address,
    code
  })
  assert.equal(verified.status, 200, 'the sign-in code was accepted')
  return ((await verified.json()) as { token: string }).token
}

async function myCameras(token: string): Promise<Listed[]> {
  const answer = await request(
    'GET',
    `/games/${game}/live-streams`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the game’s cameras were listed')
  return ((await answer.json()) as { mine: Listed[] }).mine
}

/** What one phone's driver offers the steps below. */
function steps(m: Driver): {
  find: (
    test: (node: Node) => boolean,
    wait?: number
  ) => Promise<Node | undefined>
  signIn: (link: string) => Promise<void>
  openGame: () => Promise<void>
} {
  const find = async (
    test: (node: Node) => boolean,
    wait = 10000
  ): Promise<Node | undefined> => {
    for (const until = Date.now() + wait; ;) {
      const found = flatten(await m.hierarchy()).find(
        node => test(node) && node.bounds != null && node.bounds.width > 0
      )
      if (found != null) return found
      if (Date.now() > until) return undefined
      await sleep(400)
    }
  }
  return {
    find,
    signIn: async link => {
      say('$ openLink teamstation://signin/<token>')
      await m.openLink({ link: `teamstation://signin/${link}` })
      await sleep(3000)
      if ((await find(node => node.id === 'signInLinkSignIn', 3000)) != null) {
        say('$ tapOn signInLinkSignIn')
        await m.tapOn({ id: 'signInLinkSignIn' })
      }
      await sleep(3000)
    },
    openGame: async () => {
      say(`$ openLink teamstation://games/${game}?tab=watch`)
      await m.openLink({ link: `teamstation://games/${game}?tab=watch` })
      assert(
        (await find(node => node.text === 'Box score', 30000)) != null,
        'the game opened'
      )
      await sleep(1500)
    }
  }
}

async function main(): Promise<void> {
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const daemon = await MaestroD.connect({ name: daemonName, spawn: true })
  const phone = await daemon.attach({
    device: filming,
    platform: 'android',
    appId: APP
  })
  const viewer = await daemon.attach({
    device: watching,
    platform: 'android',
    appId: APP
  })
  if (artifacts != null) await mkdir(artifacts, { recursive: true })
  const onPhone = steps(phone)
  const onViewer = steps(viewer)
  // A sign-in's code and link are one: using either spends the other, so this
  // script's session and the phone's are asked for apart.
  const token = await apiToken(email, (await askToSignIn(email)).code)
  const { link: filmerLink } = await askToSignIn(email)
  const { link: viewerLink } = await askToSignIn(viewerEmail)

  try {
    say(`$ adb shell setprop ${START_FLOOR_PROPERTY} ${OVER_ANY_PHONE}`)
    await adb(filming, 'shell', 'setprop', START_FLOOR_PROPERTY, OVER_ANY_PHONE)
    say('$ launchApp, filming phone')
    await phone.launchApp({ appId: APP, stopApp: true })
    await onPhone.signIn(filmerLink)
    await onPhone.openGame()

    say('$ tapOn Record video')
    await phone.scrollUntilVisible({
      element: { text: 'Record video' },
      centerElement: true
    })
    await phone.tapOn({ text: 'Record video' })
    assert(
      (await onPhone.find(node => node.text === 'Name this camera angle')) !=
        null,
      'Record video asks for the angle’s name'
    )
    await phone.inputText({ text: angle })
    await phone.tapOn({ text: 'Start' })
    assert(
      (await onPhone.find(node => node.id === 'broadcast-button', 20000)) !=
        null,
      'the camera opened'
    )
    await sleep(2000)
    say('$ tapOn broadcast-button')
    await phone.tapOn({ id: 'broadcast-button' })
    assert(
      (await onPhone.find(node => node.id === 'streaming-only', 20000)) != null,
      'the camera screen says it is streaming only'
    )
    assert(
      (await onPhone.find(node => node.text === 'Broadcasting', 45000)) != null,
      'the stream went live'
    )
    const live = (await myCameras(token)).find(row => row.label === angle)
    assert(live != null, 'the camera is listed')
    say(`local recording on the server: ${String(live.localRecording)}`)
    assert.equal(live.localRecording, 'none', 'no recording was reported')
    if (artifacts != null) {
      await phone.takeScreenshot({
        path: path.join(artifacts, 'streaming-only.png')
      })
    }

    say('$ launchApp, watching phone')
    await viewer.launchApp({ appId: APP, stopApp: true })
    await onViewer.signIn(viewerLink)
    await onViewer.openGame()
    // The tile holds the stream's first picture until its middle is tapped.
    const tab = await onViewer.find(node => node.text === 'Videos', 20000)
    assert(tab?.bounds != null, 'the viewer sees the Videos tab')
    await sleep(5000)
    const tile = {
      x:
        Number(
          /(\d+)x\d+/.exec(await adb(watching, 'shell', 'wm', 'size'))?.[1]
        ) / 2,
      y: Math.round(tab.bounds.y + tab.bounds.height * 4)
    }
    say(`$ adb shell input tap ${tile.x} ${tile.y}`)
    await adb(watching, 'shell', 'input', 'tap', String(tile.x), String(tile.y))
    say(`holding ${holdSeconds} s for the webcam`)
    await sleep(holdSeconds * 1000)

    say('$ tapOn broadcast-button, then slide to stop')
    await phone.tapOn({ id: 'broadcast-button' })
    const knob = await onPhone.find(
      node => node.id === 'slide-to-stop-knob',
      5000
    )
    const track = await onPhone.find(
      node => node.id === 'slide-to-stop-track',
      5000
    )
    assert(knob?.bounds != null && track?.bounds != null, 'Slide to Stop shows')
    const y = Math.round(knob.bounds.y + knob.bounds.height / 2)
    await phone.swipe({
      startX: Math.round(knob.bounds.x + knob.bounds.width / 2),
      startY: y,
      endX: track.bounds.x + track.bounds.width - 4,
      endY: y,
      duration: 800
    })
    assert(
      (await onPhone.find(
        node => node.text === 'Press record to start stream',
        20000
      )) != null,
      'the stream stopped'
    )
    const ended = (await myCameras(token)).find(row => row.id === live.id)
    say(`after Stop, local recording: ${String(ended?.localRecording)}`)
    assert.equal(ended?.localRecording, 'none', 'still no recording reported')
    say('E2 passed')
  } finally {
    say(`$ adb shell setprop ${START_FLOOR_PROPERTY} ""`)
    await adb(filming, 'shell', 'setprop', START_FLOOR_PROPERTY, '""')
    await phone.detach()
    await viewer.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
