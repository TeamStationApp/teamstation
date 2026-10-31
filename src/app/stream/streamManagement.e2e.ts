// Stream management on a game's Videos tab, through maestro-d's JavaScript
// client. `TS_STREAM_SCENARIO` picks the run. Every run needs:
//
//   MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   TS_STREAM_API=http://<LAN address>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_EMAIL=<a seeded user who may film and approves requests> \
//   TS_STREAM_VIEWER_EMAIL=<a member who cannot film> \
//   TS_STREAM_GAME=<a game> [TS_STREAM_ARTIFACT_DIR=<dir>] \
//     node -r sucrase/register src/app/stream/streamManagement.e2e.ts
//
// The local server runs without mail, so it logs each sign-in link; the app
// is signed in through its own `teamstation://signin/` link.
//
// `TS_STREAM_SCENARIO=E2` (the default), on Android phones in a debug build,
// the only kind that reads `debug.ts.phone.start_floor`:
//
//   TS_STREAM_ANDROID_SERIAL=<adb serial of the phone filming> \
//   TS_STREAM_VIEWER_SERIAL=<adb serial of the phone watching> \
//   [TS_STREAM_ANGLE=Backstop] [TS_STREAM_HOLD_SECONDS=45]
//
//   E2. The filming phone's start floor is set above its free space. Record
//   Video → the angle's name → Record with this phone → record: the stream
//   goes live with no take, the camera screen says "Streaming only", and the
//   server's list says the phone keeps no recording. The viewer's phone plays
//   the game. Stop, and the server is told of no recording.
//
// `TS_STREAM_SCENARIO=setup`, on an iOS simulator, or an Android phone given by
// `TS_STREAM_ANDROID_SERIAL`, with `TS_STREAM_GAME` a game today or later with
// no cameras, and the viewer's request not yet made:
//
//   TS_STREAM_IOS_UDID=<simulator> \
//   TS_STREAM_FULL_GAME=<a game with 6 active cameras, some of the user's> \
//   TS_STREAM_WEB=<the web app's origin> \
//   TS_STREAM_MASK_PYTHON=<a Python with Pillow, to mask keys in screenshots> \
//   [TS_STREAM_STEPS=E1,E3,E4,E11]
//
//   E1. The member taps Request access: it reads Request sent. Signed in as
//   the manager, the request is in the bell inbox: Accept. The member, back on
//   the game, has Record Video.
//   E3. Record Video → a pill → Record with this phone: the sheet is 3/4 of the
//   screen, and the camera opens, not recording, until record is tapped.
//   E4. Record Video → a pill → Use external camera → Other camera: the URL
//   shows, is the server's, and copies. Done, and the camera is listed with
//   its source. GoPro makes a camera with its source. Revoke asks, with the
//   angle in bold; Cancel returns to the URL, and Revoke takes the camera away.
//   E11. On a full game Record Video is disabled with its reason, and the web
//   panel says so too. End one, and both allow a new one.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

import puppeteer from 'puppeteer'

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
  enabled?: boolean
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
    platform: 'android' | 'ios'
    appId: string
  }) => Promise<Driver>
}
interface Listed {
  id: string
  label: string
  state: string
  localRecording?: string
  source?: string | null
  publishedAt?: string | null
}
interface Access {
  canFilm: boolean
  canRequest: boolean
  requested: boolean
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const scenario = process.env.TS_STREAM_SCENARIO ?? 'E2'
const daemonName = required('MAESTRO_D')
const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
const api = required('TS_STREAM_API').replace(/\/$/, '')
const serverLog = required('TS_STREAM_SERVER_LOG')
const email = required('TS_STREAM_EMAIL')
const viewerEmail = required('TS_STREAM_VIEWER_EMAIL')
const game = required('TS_STREAM_GAME')
const angle = process.env.TS_STREAM_ANGLE ?? 'Backstop'
const wanted = (process.env.TS_STREAM_STEPS ?? 'E1,E3,E4,E11').split(',')
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

async function camerasOf(
  token: string,
  gameId: string
): Promise<{
  mine: Listed[]
  others: Listed[]
  canAdd: number
  gameCanAdd: number
}> {
  const answer = await request(
    'GET',
    `/games/${gameId}/live-streams`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the game’s cameras were listed')
  return (await answer.json()) as Awaited<ReturnType<typeof camerasOf>>
}

async function myCameras(token: string): Promise<Listed[]> {
  return (await camerasOf(token, game)).mine
}

async function accessOf(token: string): Promise<Access> {
  const answer = await request(
    'GET',
    `/games/${game}/stream-access`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'stream access answered')
  return (await answer.json()) as Access
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

async function connect(): Promise<Daemon> {
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  return await MaestroD.connect({ name: daemonName, spawn: true })
}

async function e2(): Promise<void> {
  const filming = required('TS_STREAM_ANDROID_SERIAL')
  const watching = required('TS_STREAM_VIEWER_SERIAL')
  const daemon = await connect()
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

    say('$ tapOn Record Video')
    await phone.scrollUntilVisible({
      element: { text: 'Record Video' },
      centerElement: true
    })
    await phone.tapOn({ text: 'Record Video' })
    assert(
      (await onPhone.find(node => node.text === 'Name this camera angle')) !=
        null,
      'Record Video asks for the angle’s name'
    )
    await phone.inputText({ text: angle })
    await phone.tapOn({ text: 'Record with this phone' })
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

const URL_LETTER_POINTS = 5.8

/** Blacks out the stream key at the end of a URL on a screenshot. */
async function maskKey(
  python: string,
  file: string,
  url: string,
  box: Bounds,
  screenWidth: number
): Promise<void> {
  const key = url.lastIndexOf('/') + 1
  const script = `
import sys
from PIL import Image, ImageDraw
path, x, y, w, h, screen = sys.argv[1], *map(float, sys.argv[2:7])
image = Image.open(path).convert('RGB')
scale = image.width / screen
ImageDraw.Draw(image).rectangle(
    [x * scale, y * scale, (x + w) * scale, (y + h) * scale], fill=(0, 0, 0))
image.save(path)
`
  // The field is wider than the URL, whose letters are proportional: this
  // falls just short of the key at the sheet's size.
  const start = box.x + key * URL_LETTER_POINTS
  await run(python, [
    '-c',
    script,
    file,
    String(start),
    String(box.y),
    String(box.x + box.width - start),
    String(box.height),
    String(screenWidth)
  ])
}

async function setup(): Promise<void> {
  const androidSerial = process.env.TS_STREAM_ANDROID_SERIAL
  const device = androidSerial ?? required('TS_STREAM_IOS_UDID')
  const fullGame = required('TS_STREAM_FULL_GAME')
  const web = required('TS_STREAM_WEB').replace(/\/$/, '')
  const python = required('TS_STREAM_MASK_PYTHON')
  const daemon = await connect()
  const m = await daemon.attach({
    device,
    platform: androidSerial == null ? 'ios' : 'android',
    appId: APP
  })
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
  /** Passes once nothing matches: a sheet has gone. */
  const gone = async (
    test: (node: Node) => boolean,
    wait = 10000
  ): Promise<boolean> => {
    for (const until = Date.now() + wait; Date.now() < until;) {
      if ((await find(test, 0)) == null) return true
      await sleep(300)
    }
    return false
  }
  const shot = async (name: string): Promise<string | undefined> => {
    if (artifacts == null) return undefined
    await sleep(700)
    const file = path.join(artifacts, name)
    say(`$ takeScreenshot ${name}`)
    await m.takeScreenshot({ path: file })
    return file
  }
  const tap = async (id: string): Promise<void> => {
    say(`$ tapOn ${id}`)
    await m.tapOn({ id })
  }
  const signIn = async (address: string): Promise<void> => {
    const { link } = await askToSignIn(address)
    say(`$ openLink teamstation://signin/<token> (${address})`)
    await m.openLink({ link: `teamstation://signin/${link}` })
    await sleep(3000)
    if ((await find(byId('signInLinkSignIn'), 3000)) != null)
      await tap('signInLinkSignIn')
    assert(
      await gone(byText('Sign in to TeamStation'), 20000),
      `signed in as ${address}`
    )
  }
  const signOut = async (): Promise<void> => {
    const account = await find(
      node => node.text?.startsWith('Account, ') === true,
      10000
    )
    assert(account?.text != null, 'the header has an account button')
    say(`$ tapOn ${account.text}`)
    await m.tapOn({ text: account.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') })
    say('$ scrollUntilVisible Sign out')
    await m.scrollUntilVisible({ element: { text: 'Sign out' } })
    const button = await find(byText('Sign out'), 5000)
    assert(button?.bounds != null, 'Sign out shows')
    await m.tapOn({
      point: `${Math.round(button.bounds.x + 12)},${Math.round(button.bounds.y + button.bounds.height / 2)}`
    })
    assert(
      (await find(byText('Sign in to TeamStation'), 15000)) != null,
      'signed out'
    )
  }
  const openGame = async (id = game): Promise<void> => {
    say(`$ openLink teamstation://games/${id}?tab=watch`)
    await m.openLink({ link: `teamstation://games/${id}?tab=watch` })
    assert((await find(byText('Box score'), 30000)) != null, 'the game opened')
    await sleep(1500)
  }
  /** The largest box drawn: Android's root has no bounds of its own. */
  const screen = async (): Promise<Bounds> =>
    (await nodes())
      .flatMap(node => (node.bounds == null ? [] : [node.bounds]))
      .reduce((one, two) => (two.height > one.height ? two : one))
  const sheetShare = async (id: string): Promise<number> => {
    const sheet = await find(byId(id))
    assert(sheet?.bounds != null, `${id} shows`)
    return sheet.bounds.height / (await screen()).height
  }
  /** Record Video → the pill → the row. Answers once the row was tapped. */
  const named = async (pill: string, row: string): Promise<void> => {
    assert((await find(byId('record-video'), 15000)) != null, 'Record Video')
    await tap('record-video')
    assert(
      (await find(byId('angle-name-prompt'))) != null,
      'Record Video slides up the name sheet'
    )
    await tap(`angle-suggestion-${pill}`)
    await tap(row)
  }

  const token = await apiToken(email, (await askToSignIn(email)).code)
  const viewerToken = await apiToken(
    viewerEmail,
    (await askToSignIn(viewerEmail)).code
  )
  const verify = async (message: string): Promise<void> => {
    say(`observed: ${message}`)
  }
  await m.launchApp({ appId: APP, stopApp: true })
  await sleep(3000)
  let signedInAs: string | undefined
  const become = async (address: string): Promise<void> => {
    if (signedInAs === address) return
    // Whoever the app was left signed in as stays, whatever link it is handed.
    const account = (node: Node): boolean =>
      node.text?.startsWith('Account, ') === true
    if (signedInAs != null || (await find(account, 4000)) != null)
      await signOut()
    await signIn(address)
    signedInAs = address
  }

  try {
    if (wanted.includes('E1')) {
      const before = await accessOf(viewerToken)
      assert(
        before.canRequest && !before.canFilm && !before.requested,
        'a member who has not asked'
      )
      await become(viewerEmail)
      await openGame()
      assert(
        (await find(byText('No videos'), 15000)) != null,
        'the empty state shows'
      )
      assert(
        (await find(byText('Want to record video for this game?'))) != null,
        'it asks whether they want to record'
      )
      assert(await gone(byId('record-video'), 1000), 'no Record Video')
      assert(await gone(byId('gameVideoNotice'), 1000), 'no notice beside it')
      await shot('videos-nofilm-after.png')
      await tap('request-access')
      assert((await find(byText('Request sent'))) != null, 'Request sent shows')
      assert((await accessOf(viewerToken)).requested, 'the server has it')
      await verify('E1 the member asked: Request sent, requested on the server')

      await become(email)
      say('$ openLink teamstation://notifications')
      await m.openLink({ link: 'teamstation://notifications' })
      const item = await find(
        node => node.text?.includes('asks to film') === true,
        20000
      )
      assert(item != null, 'the request is in the bell inbox')
      await verify(`E1 inbox reads: ${String(item.text)}`)
      await shot('request-approve.png')
      await tap('notification-accept')
      for (const until = Date.now() + 15000; Date.now() < until;) {
        if ((await accessOf(viewerToken)).canFilm) break
        await sleep(500)
      }
      assert((await accessOf(viewerToken)).canFilm, 'Accept made them film')

      await become(viewerEmail)
      await openGame()
      assert(
        (await find(byId('record-video'), 15000)) != null,
        'the member now has Record Video'
      )
      assert(await gone(byId('request-access'), 1000), 'no Request access')
      await verify('E1 passed: the member has Record Video after approval')
    }

    if (wanted.includes('E3')) {
      await become(email)
      await openGame()
      assert((await find(byText('No videos'), 15000)) != null, 'empty state')
      assert((await find(byId('record-video'))) != null, 'Record Video')
      await shot('videos-empty-after.png')
      await tap('record-video')
      const share = await sheetShare('angle-name-prompt')
      say(`observed: the name sheet is ${(share * 100).toFixed(1)}% tall`)
      await tap('angle-suggestion-Home')
      await shot('setup-name-after.png')
      await tap('record-with-phone')
      assert(
        (await find(byId('broadcast-button'), 20000)) != null,
        'the camera opened after the sheet left'
      )
      assert(
        (await find(byText('Press record to start stream'), 8000)) != null,
        'the camera waits for the record button'
      )
      const made = (await myCameras(token)).find(row => row.label === 'Home')
      assert(made != null, 'the phone’s camera is listed')
      assert.equal(made.state, 'idle', 'nothing is on the air')
      assert(made.publishedAt == null, 'no video has reached it')
      await verify(
        'E3 passed: name sheet, the pill’s name, camera open and idle'
      )
      await tap('camera-close')
      assert(
        (await find(byText('Box score'), 15000)) != null,
        'back on the tab'
      )
      for (const stream of [
        ['end', 'POST'],
        ['', 'DELETE']
      ])
        await request(
          stream[1],
          `/games/${game}/live-streams/${made.id}${stream[0] === '' ? '' : '/end'}`,
          stream[1] === 'POST' ? {} : undefined,
          token
        )
    }

    if (wanted.includes('E4')) {
      await become(email)
      await openGame()
      const before = (await myCameras(token)).length
      await named('Backstop', 'use-external-camera')
      assert(
        (await find(byId('camera-source-sheet'))) != null,
        'Use external camera steps to the next sheet on iOS'
      )
      const share = await sheetShare('camera-source-sheet')
      assert(share > 0.7 && share < 0.8, `the sheet is ${share} of the screen`)
      for (const words of [
        'GoPro',
        'Mevo Studio',
        'RTMP compatible camera',
        'Stream with your camera'
      ])
        assert(
          (await find(node => node.text?.includes(words) === true, 3000)) !=
            null,
          words
        )
      assert.equal(
        (await myCameras(token)).length,
        before,
        'no camera is made until the RTMP sheet opens'
      )
      await shot('setup-source.png')
      await tap('camera-source-rtmp')
      const shown = await find(byId('rtmp-url'), 15000)
      assert(shown?.text != null && shown.bounds != null, 'the URL shows')
      const url = shown.text
      assert.match(url, /^rtmps?:\/\//, 'an RTMP URL')
      const backstop = (await myCameras(token)).find(
        row => row.label === 'Backstop'
      )
      assert(backstop != null, 'the camera was made as the sheet opened')
      assert.equal(backstop.source, 'rtmp', 'with its source')
      const revealed = await request(
        'POST',
        `/games/${game}/live-streams/${backstop.id}/reveal`,
        {},
        token
      )
      assert.equal(
        ((await revealed.json()) as { url: string }).url,
        url,
        'the sheet shows the server’s URL'
      )
      const rtmpShare = await sheetShare('rtmp-url-sheet')
      assert(rtmpShare > 0.7 && rtmpShare < 0.8, `RTMP sheet ${rtmpShare}`)
      await tap('rtmp-copy')
      assert((await find(byId('rtmp-copied'))) != null, 'Copied shows')
      // Android gives a shell no way to read the clipboard, and its preview
      // of a copy sits over the sheet's foot for a few seconds, key and all.
      if (androidSerial != null) await sleep(10000)
      else {
        const pasted = (
          await run('xcrun', ['simctl', 'pbpaste', device])
        ).stdout.trim()
        assert.equal(pasted, url, 'the clipboard holds the URL')
      }
      await verify('E4 URL shown equals the server’s, and copied to clipboard')
      const rtmpFile = await shot('setup-rtmp.png')
      const box = (await find(byId('rtmp-url')))?.bounds
      if (rtmpFile != null && box != null)
        await maskKey(python, rtmpFile, url, box, (await screen()).width)
      await tap('rtmp-done')
      assert(await gone(byId('rtmp-url-sheet')), 'Done closes the sheet')
      assert(
        (await find(byText('Backstop'), 10000)) != null,
        'the camera has its row'
      )

      await named('1st', 'use-external-camera')
      assert(
        (await find(byId('camera-source-sheet'))) != null,
        'the camera’s make'
      )
      await tap('camera-source-gopro')
      assert((await find(byId('rtmp-url'), 15000)) != null, 'GoPro’s URL')
      const gopro = (await myCameras(token)).find(row => row.label === '1st')
      assert.equal(gopro?.source, 'gopro', 'a camera with its source')
      await tap('rtmp-revoke')
      assert(
        (await find(byId('revoke-sheet'))) != null,
        'Revoke asks first, once the sheet has gone'
      )
      assert(
        (await find(
          node => node.text?.includes('cancel the stream of') === true
        )) != null,
        'the confirmation says what it does'
      )
      await shot('revoke-confirm.png')
      assert(
        (await myCameras(token)).some(row => row.id === gopro.id),
        'asking changes nothing'
      )
      await m.tapOn({ text: 'Cancel' })
      assert((await find(byId('rtmp-url'), 10000)) != null, 'back at the URL')
      await tap('rtmp-revoke')
      assert((await find(byId('revoke-sheet'))) != null, 'it asks again')
      await tap('revoke-confirm')
      assert(await gone(byId('revoke-sheet')), 'the confirmation goes')
      assert(await gone(byText('1st'), 12000), 'the row goes from the tab')
      assert(
        !(await myCameras(token)).some(row => row.id === gopro.id),
        'the camera is gone from the list'
      )
      await verify('E4 passed: GoPro source, Revoke, Cancel, confirm, row gone')
      await request(
        'POST',
        `/games/${game}/live-streams/${backstop.id}/end`,
        {},
        token
      )
      await request(
        'DELETE',
        `/games/${game}/live-streams/${backstop.id}`,
        undefined,
        token
      )
      assert(
        (await find(byText('No videos'), 12000)) != null,
        'the tab is empty again'
      )
    }

    if (wanted.includes('E11')) {
      const full = await camerasOf(token, fullGame)
      assert.equal(full.gameCanAdd, 0, 'the game is full')
      const reason = 'This game already has 6 cameras. End one to add another.'
      await become(email)
      await openGame(fullGame)
      const limit = await find(byId('record-video-limit'), 15000)
      assert.equal(limit?.text, reason, 'Record Video says why')
      await tap('record-video')
      assert(
        await gone(byId('angle-name-prompt'), 2000),
        'a disabled Record Video opens nothing'
      )
      await sleep(1000)
      assert(
        (await find(byId('angle-name-prompt'), 0)) == null,
        'still nothing opened'
      )
      await shot('limit-phone-after.png')

      const browser = await puppeteer.launch({ headless: true })
      const { link } = await askToSignIn(email)
      try {
        const page = await browser.newPage()
        await page.setViewport({
          width: 1280,
          height: 1000,
          deviceScaleFactor: 2
        })
        await page.goto(`${web}/signin/${link}`, { waitUntil: 'networkidle2' })
        await page
          .waitForSelector('[data-testid="signInLinkSignIn"]', {
            timeout: 5000
          })
          .then(async button => {
            await button?.click()
          })
          .catch(() => undefined)
        await sleep(2500)
        await page.goto(`${web}/games/${fullGame}?tab=watch`, {
          waitUntil: 'networkidle2'
        })
        await page.waitForFunction(
          (words: string) => document.body.innerText.includes(words),
          { timeout: 20000 },
          reason
        )
        if (artifacts != null) {
          // A camera nothing streams to shows its URL whole: no key in the shot.
          await page.evaluate(() => {
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT
            )
            for (let node = walker.nextNode(); node != null;) {
              // No optional chain: this runs in the page, without its helper.
              const words = String(node.textContent)
              if (words.includes('rtmp'))
                node.textContent = words.replace(/\/[^/]+$/, '/ts_••••••••')
              node = walker.nextNode()
            }
          })
          const scrolled = await page.evaluateHandle((words: string) => {
            return [...document.querySelectorAll('div')].find(
              node => node.textContent === words
            )
          }, reason)
          await scrolled.asElement()?.evaluate(node => {
            ;(node as HTMLElement).scrollIntoView({ block: 'center' })
          })
          await sleep(500)
          await page.screenshot({
            path: path.join(artifacts, 'limit-web-after.png')
          })
        }
        await verify('E11 the phone and the web panel both give the reason')

        const mine = full.mine.find(row => row.state === 'idle')
        assert(mine != null, 'one of the user’s to end')
        say('$ curl -X POST …/end')
        const ended = await request(
          'POST',
          `/games/${fullGame}/live-streams/${mine.id}/end`,
          {},
          token
        )
        assert.equal(ended.status, 200, 'End answered')
        assert(
          await gone(byId('record-video-limit'), 12000),
          'the phone’s reason goes on its next read'
        )
        await tap('record-video')
        assert(
          (await find(byId('angle-name-prompt'))) != null,
          'Record Video opens again'
        )
        await m.tapOn({ id: 'sheet-cancel' })
        assert(await gone(byId('angle-name-prompt')), 'Cancel closes it')
        await page.reload({ waitUntil: 'networkidle2' })
        await sleep(2000)
        assert(
          !(await page.evaluate(
            (words: string) => document.body.innerText.includes(words),
            reason
          )),
          'the web panel no longer says the game is full'
        )
        const added = await request(
          'POST',
          `/games/${fullGame}/live-streams`,
          { label: mine.label, source: 'rtmp' },
          token
        )
        assert.equal(added.status, 201, 'a new camera takes the place')
        await verify(
          'E11 passed: End freed a place on both, and a camera took it'
        )
      } finally {
        await browser.close()
      }
    }
    say(`setup passed: ${wanted.join(', ')}`)
  } finally {
    await m.detach()
  }
}

;(scenario === 'setup' ? setup() : e2()).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
