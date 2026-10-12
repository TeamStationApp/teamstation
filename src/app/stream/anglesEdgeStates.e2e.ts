// E17: the phone's camera list at its edges. Through maestro-d's JavaScript
// client, on an iOS simulator or an iPhone.
//
//   TS_STREAM_IOS_UDID=<device> MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   [TS_STREAM_TEAM_ID=<WebDriverAgent signing team, for a real device>] \
//   TS_STREAM_API=http://<address>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_EMAIL=<a seeded user who may film> \
//   TS_STREAM_VIEWER_EMAIL=<a user who may see the game but not film it> \
//   TS_STREAM_GAME=<a game with no cameras of this user's> \
//   [TS_STREAM_ARTIFACT_DIR=<dir>] \
//     node -r sucrase/register src/app/stream/anglesEdgeStates.e2e.ts
//
// The local server runs without mail, so it logs each sign-in link; the app
// is signed in through its own `teamstation://signin/` link.
//
//   1. A game with no cameras: Cameras holds Record video and nothing else
//      (angles-empty.png).
//   2. A second device of the same account (a `POST …/live-streams` posing as
//      device B) makes "Second Base".
//   3. Record video with "Second Base": the 409 shows in the prompt
//      (angle-duplicate-409.png). Cancel.
//   4. Record video with "Home Plate" → Start, then Close.
//   5. This phone's "Home Plate" row opens the camera again on the same
//      stream: the game still has one Home Plate, with the same id. Close.
//   6. Signed in as somebody who may not film: no Cameras. Back as the
//      seeded user.
//   7. "…" on "Home Plate": Copy stream URL, Rotate key, End and Remove.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

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
  assertNotVisible: (options: { text: string }) => Promise<unknown>
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
const email = required('TS_STREAM_EMAIL')
const viewerEmail = required('TS_STREAM_VIEWER_EMAIL')
const game = required('TS_STREAM_GAME')
const teamId = process.env.TS_STREAM_TEAM_ID
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const APP = 'app.teamstation.app'
/** Device B: another phone of the same account. */
const DEVICE_B = '00000000-0000-4000-8000-00000000000b'
const TAKEN = 'Second Base'
const ANGLE = 'Home Plate'

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

/** Asks for a sign-in mail; the local server logs its code and link instead. */
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

async function apiToken(address: string): Promise<string> {
  const { code } = await askToSignIn(address)
  const verified = await request('POST', '/auth/email-code/verify', {
    email: address,
    code
  })
  assert.equal(verified.status, 200, 'the sign-in code was accepted')
  return ((await verified.json()) as { token: string }).token
}

interface StreamRow {
  id: string
  label: string
  state: string
  deviceId?: string | null
  deviceModel?: string | null
}

async function cameras(
  token: string
): Promise<{ mine: StreamRow[]; others: StreamRow[] }> {
  const answer = await request(
    'GET',
    `/games/${game}/live-streams`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the game’s cameras were listed')
  return (await answer.json()) as { mine: StreamRow[]; others: StreamRow[] }
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
  const containing = (text: string) => (node: Node) =>
    node.text?.includes(text) === true
  const shot = async (name: string): Promise<void> => {
    if (artifacts == null) return
    say(`$ takeScreenshot ${name}`)
    await m.takeScreenshot({ path: path.join(artifacts, name) })
  }

  /** Signs the app in as `address` through its own sign-in link. */
  const signIn = async (address: string): Promise<void> => {
    const { link } = await askToSignIn(address)
    say(`$ openLink teamstation://signin/<token> (${address})`)
    await m.openLink({ link: `teamstation://signin/${link}` })
    await sleep(3000)
    if ((await find(byId('signInLinkSignIn'), 3000)) != null) {
      say('$ tapOn signInLinkSignIn')
      await m.tapOn({ id: 'signInLinkSignIn' })
    }
    for (const until = Date.now() + 20000; Date.now() < until;) {
      if ((await find(byText('Sign in to TeamStation'), 0)) == null) return
      await sleep(500)
    }
    throw new Error(`The app did not sign in as ${address}`)
  }
  const signOut = async (): Promise<void> => {
    const account = await find(
      node => node.text?.startsWith('Account, ') === true,
      10000
    )
    assert(account?.text != null, 'the header has an account button')
    say(`$ tapOn ${account.text}`)
    await m.tapOn({ text: escape(account.text) })
    say('$ scrollUntilVisible Sign out')
    await m.scrollUntilVisible({ element: { text: 'Sign out' } })
    // The page ends with the button under the floating tab bar: tap its left
    // end, which the bar does not cover.
    const button = await find(byText('Sign out'), 5000)
    assert(button?.bounds != null, 'Sign out shows')
    const point = `${Math.round(button.bounds.x + 12)},${Math.round(button.bounds.y + button.bounds.height / 2)}`
    say(`$ tapOn Sign out (point ${point})`)
    await m.tapOn({ point })
    assert(
      (await find(byText('Sign in to TeamStation'), 15000)) != null,
      'signed out'
    )
  }
  const openGame = async (): Promise<void> => {
    say(`$ openLink teamstation://games/${game}?tab=watch`)
    await m.openLink({ link: `teamstation://games/${game}?tab=watch` })
    assert((await find(byText('Box score'), 30000)) != null, 'the game opened')
    await sleep(1500)
  }
  const recordVideo = async (name: string): Promise<void> => {
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
    say(`$ inputText ${name}`)
    await m.inputText({ text: name })
    say('$ tapOn Start')
    await m.tapOn({ text: 'Start' })
  }
  const closeCamera = async (): Promise<void> => {
    assert(
      (await find(byId('camera-close'), 20000)) != null,
      'the streaming screen opened'
    )
    await sleep(1500)
    say('$ tapOn camera-close')
    await m.tapOn({ id: 'camera-close' })
    assert(
      (await find(byText('Record video'), 15000)) != null,
      'Close goes back to the game'
    )
  }

  try {
    say('$ launchApp')
    await m.launchApp({ appId: APP, stopApp: true })
    if ((await find(byText('Sign in to TeamStation'), 12000)) == null) {
      // Whoever the app is signed in as, start from the seeded user.
      await signOut()
    }
    await signIn(email)
    const token = await apiToken(email)
    const before = await cameras(token)
    assert.deepEqual(
      [...before.mine, ...before.others].map(row => row.label),
      [],
      'the game starts with no cameras'
    )

    // 1. Nothing but Record video.
    await openGame()
    say('$ scrollUntilVisible Record video')
    await m.scrollUntilVisible({
      element: { text: 'Record video' },
      centerElement: true
    })
    assert((await find(byText('CAMERAS'), 5000)) != null, 'Cameras shows')
    const rows = (await nodes()).filter(
      node =>
        node.id?.startsWith('angle-row-') === true ||
        node.id?.startsWith('upload-row-') === true
    )
    assert.deepEqual(rows, [], 'no camera rows')
    await shot('angles-empty.png')
    results.push('1 a game with no cameras: Cameras holds only Record video')

    // 2. Device B, the same account, makes "Second Base".
    say(
      `$ curl -X POST ${api}/games/${game}/live-streams -d '{"label":"${TAKEN}","deviceId":"${DEVICE_B}","deviceModel":"Pixel 10","recordsLocally":true}'`
    )
    const made = await request(
      'POST',
      `/games/${game}/live-streams`,
      {
        label: TAKEN,
        deviceId: DEVICE_B,
        deviceModel: 'Pixel 10',
        recordsLocally: true
      },
      token
    )
    assert.equal(made.status, 201, 'device B’s camera was made')
    results.push(`2 device B made “${TAKEN}”: ${made.status}`)

    // 3. The same name from this phone: 409, in the prompt.
    await recordVideo(TAKEN)
    const refusal = await find(
      containing(`You already have a camera called ${TAKEN}`),
      15000
    )
    assert(refusal != null, 'the 409 shows in the prompt')
    await shot('angle-duplicate-409.png')
    say('$ tapOn Cancel')
    await m.tapOn({ text: 'Cancel' })
    await sleep(1500)
    results.push(`3 Record video “${TAKEN}”: “${refusal.text ?? ''}”`)

    // 4. "Home Plate", then Close.
    await recordVideo(ANGLE)
    await closeCamera()
    const home = (await cameras(token)).mine.find(row => row.label === ANGLE)
    assert(home != null, 'the phone has a Home Plate camera')
    results.push(`4 Record video “${ANGLE}” made stream ${home.id}`)

    // 5. Its row opens the camera again, on the same stream.
    const row = await find(byId(`angle-row-${home.id}`), 15000)
    assert(row != null, 'this phone lists its own Home Plate')
    say(`$ tapOn angle-row-${home.id}`)
    await m.tapOn({ id: `angle-row-${home.id}` })
    await closeCamera()
    // The server logs no requests: its list says which stream was answered.
    const after = (await cameras(token)).mine.filter(one => one.label === ANGLE)
    say(
      `$ curl ${api}/games/${game}/live-streams: ${ANGLE} ${after.map(one => one.id).join(', ')}`
    )
    assert.deepEqual(
      after.map(one => one.id),
      [home.id],
      'the same stream, and no other'
    )
    results.push(`5 the row reopened the camera on the same stream, ${home.id}`)

    // 6. Somebody who may not film sees no Cameras.
    await signOut()
    await signIn(viewerEmail)
    await openGame()
    await m
      .scrollUntilVisible({ element: { text: 'CAMERAS' }, timeout: 8000 })
      .catch(() => undefined)
    say('$ assertNotVisible CAMERAS')
    await m.assertNotVisible({ text: 'CAMERAS' })
    say('$ assertNotVisible Record video')
    await m.assertNotVisible({ text: 'Record video' })
    await signOut()
    await signIn(email)
    results.push(`6 ${viewerEmail}: no Cameras; signed back in as ${email}`)

    // 7. The "…" on Home Plate.
    await openGame()
    say(`$ scrollUntilVisible angle-more-${home.id}`)
    await m.scrollUntilVisible({
      element: { id: `angle-more-${home.id}` },
      centerElement: true
    })
    say(`$ tapOn angle-more-${home.id}`)
    await m.tapOn({ id: `angle-more-${home.id}` })
    const offered: string[] = []
    for (const word of ['Copy stream URL', 'Rotate key', 'End', 'Remove']) {
      const found = await find(byText(word), 8000)
      assert(found != null, `the sheet offers ${word}`)
      say(`$ assertVisible ${word}`)
      offered.push(word)
    }
    say('$ tapOn Cancel')
    await m.tapOn({ text: 'Cancel' })
    results.push(`7 “…” on ${ANGLE}: ${offered.join(', ')}`)
  } finally {
    await m.detach()
  }
  for (const line of results) say(`PASS ${line}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
