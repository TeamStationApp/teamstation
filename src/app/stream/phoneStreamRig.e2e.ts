// What E15 (twoDevices.e2e.ts) and E16 (uploadRecording.e2e.ts) share: the
// local server's API and sign-in, a phone driven through maestro-d's
// JavaScript client (an iPhone, its simulator, or an Android phone), and
// stand-in devices made with `curl` and fed by ffmpeg when the hardware is
// not there.
//
// Environment, read by both scripts:
//   MAESTRO_D=<this agent's daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package>
//   [MAESTRO_D_BIN=<binary>] [TS_STREAM_TEAM_ID=<WebDriverAgent team, real iPhone>]
//   TS_STREAM_API=http://<address>:<port>/api/v1
//   TS_STREAM_SERVER_LOG=<the local server's log, which carries sign-in links>
//   TS_STREAM_EMAIL=<a seeded user who may film> TS_STREAM_GAME=<a game>
//   [TS_STREAM_TOKEN=<a session of that user's, for the script's own calls>]
//   [TS_STREAM_ARTIFACT_DIR=<dir>]
import assert from 'node:assert/strict'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
export interface UiNode {
  id?: string
  text?: string
  bounds?: Bounds
  children?: UiNode[]
}
type Selector = { text: string } | { id: string } | { point: string }
export interface Driver {
  hierarchy: () => Promise<UiNode>
  takeScreenshot: (options: { path: string }) => Promise<unknown>
  launchApp: (options: { appId: string; stopApp?: boolean }) => Promise<unknown>
  stopApp: (options: { appId: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (target: Selector) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  scrollUntilVisible: (options: {
    element: { text: string } | { id: string }
    centerElement?: boolean
    timeout?: number
  }) => Promise<unknown>
  swipe: (
    gesture:
      | {
          startX: number
          startY: number
          endX: number
          endY: number
          duration: number
        }
      | { start: string; end: string; duration: number }
  ) => Promise<unknown>
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

export const APP = 'app.teamstation.app'

export const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
export const optional = (key: string): string | undefined => {
  const value = process.env[key]
  return value == null || value === '' ? undefined : value
}

export const api = (): string => required('TS_STREAM_API').replace(/\/$/, '')
export const game = (): string => required('TS_STREAM_GAME')

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const started = Date.now()
export const say = (line: string): void => {
  console.log(
    `${new Date().toISOString()} +${((Date.now() - started) / 1000).toFixed(1)}s ${line}`
  )
}
const flatten = (node: UiNode): UiNode[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const request = async (
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<Response> =>
  await fetch(`${api()}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token == null ? {} : { authorization: `Bearer ${token}` })
    },
    body: body == null ? undefined : JSON.stringify(body)
  })

async function fromServerLog(pattern: RegExp, offset: number): Promise<string> {
  const log = required('TS_STREAM_SERVER_LOG')
  for (const until = Date.now() + 20000; Date.now() < until;) {
    const match = pattern.exec((await readFile(log, 'utf8')).slice(offset))
    if (match?.[1] != null) return match[1]
    await sleep(300)
  }
  throw new Error(`Nothing matching ${String(pattern)} in the server log`)
}

/** Asks for a sign-in mail; the local server logs its code and link instead. */
export async function askToSignIn(
  email: string
): Promise<{ code: string; link: string }> {
  const offset = (await readFile(required('TS_STREAM_SERVER_LOG'), 'utf8'))
    .length
  const asked = await request('POST', '/auth/email-code', { email })
  assert.equal(asked.status, 202, 'the sign-in code was sent')
  const code = await fromServerLog(
    new RegExp(`sign-in code for ${escape(email)}: (\\d{6})`),
    offset
  )
  const link = await fromServerLog(
    /link: https?:\/\/[^/\s]+\/signin\/([A-Za-z0-9_-]+)/,
    offset
  )
  return { code, link }
}

/** A session for the script's own API calls: `TS_STREAM_TOKEN`, or a fresh sign-in. */
export async function apiToken(email: string): Promise<string> {
  const given = optional('TS_STREAM_TOKEN')
  if (given != null) return given
  const { code } = await askToSignIn(email)
  const verified = await request('POST', '/auth/email-code/verify', {
    email,
    code
  })
  assert.equal(verified.status, 200, 'the sign-in code was accepted')
  return ((await verified.json()) as { token: string }).token
}

export interface StreamRow {
  id: string
  label: string
  state: string
  videoId: string | null
  deviceId?: string | null
  deviceModel?: string | null
  localRecording?: string
  url?: string
}

export async function cameras(
  token: string
): Promise<{ mine: StreamRow[]; others: StreamRow[] }> {
  const answer = await request(
    'GET',
    `/games/${game()}/live-streams`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the game’s cameras were listed')
  return (await answer.json()) as { mine: StreamRow[]; others: StreamRow[] }
}

/** Takes this account's cameras with these names off the game, from earlier runs. */
export async function clearAngles(
  token: string,
  names: string[]
): Promise<void> {
  const wanted = new Set(names.map(name => name.toLowerCase()))
  for (const row of (await cameras(token)).mine) {
    if (!wanted.has(row.label.toLowerCase())) continue
    say(
      `$ curl -X DELETE …/live-streams/${row.id} (${row.label}, an earlier run’s)`
    )
    const removed = await request(
      'DELETE',
      `/games/${game()}/live-streams/${row.id}`,
      undefined,
      token
    )
    assert(removed.ok, `removing ${row.id}: ${removed.status}`)
  }
}

/**
 * A device that is not here, made through the API as the same account: its
 * camera, and ffmpeg publishing a test picture to it so it reads Live.
 */
export interface StandIn {
  stream: StreamRow
  stop: () => Promise<void>
}

export async function standIn(
  token: string,
  options: {
    label: string
    deviceId: string
    deviceModel: string
    recordsLocally: boolean
    publish: boolean
  }
): Promise<StandIn> {
  const { label, deviceId, deviceModel, recordsLocally, publish } = options
  say(
    `$ curl -X POST ${api()}/games/${game()}/live-streams -d '${JSON.stringify({ label, deviceId, deviceModel, recordsLocally })}'`
  )
  const made = await request(
    'POST',
    `/games/${game()}/live-streams`,
    { label, deviceId, deviceModel, recordsLocally },
    token
  )
  assert(made.ok, `the stand-in ${label} was made: ${made.status}`)
  const stream = (await made.json()) as StreamRow
  let url = stream.url
  if (url == null) {
    const revealed = await request(
      'POST',
      `/games/${game()}/live-streams/${stream.id}/reveal`,
      {},
      token
    )
    url = ((await revealed.json()) as StreamRow).url
  }
  let ffmpeg: ChildProcess | undefined
  let stopping = false
  // Like a real encoder, it dials again when the ingest drops it.
  const dial = (target: string): void => {
    ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        // TeamStation's ingest takes HEVC only, over enhanced RTMP.
        '-c:v',
        'hevc_videotoolbox',
        '-realtime',
        '1',
        '-g',
        '60',
        '-b:v',
        '2M',
        '-c:a',
        'aac',
        '-f',
        'flv',
        target
      ],
      { stdio: 'ignore' }
    )
    ffmpeg.on('exit', () => {
      if (stopping) return
      say(`${label}: the ingest dropped the stand-in; dialling again`)
      setTimeout(() => {
        if (!stopping) dial(target)
      }, 2000)
    })
  }
  if (publish) {
    assert(url != null, 'the stand-in has a stream URL')
    say(`$ ffmpeg -re testsrc2 + sine, HEVC → <${label}'s stream URL>`)
    dial(url)
  }
  return {
    stream,
    stop: async () => {
      stopping = true
      if (ffmpeg == null || ffmpeg.exitCode != null) return
      ffmpeg.kill('SIGINT')
      await sleep(1500)
    }
  }
}

/** Waits until the server says a camera is publishing. */
export async function waitPublishing(
  token: string,
  id: string,
  wait = 45000
): Promise<void> {
  for (const until = Date.now() + wait; Date.now() < until;) {
    const all = await cameras(token)
    if (
      [...all.mine, ...all.others].some(
        row => row.id === id && row.state === 'publishing'
      )
    )
      return
    await sleep(1000)
  }
  throw new Error(`${id} never went live`)
}

/** A video's playback URL, as the app plays it, and what ffprobe reads there. */
export async function probePlayback(
  token: string,
  videoId: string
): Promise<{ url: string; probe: string }> {
  const answer = await request(
    'GET',
    `/videos/${videoId}/playback`,
    undefined,
    token
  )
  assert.equal(answer.status, 200, `playback of ${videoId}`)
  const { url } = (await answer.json()) as { url: string | null }
  assert(url != null, `${videoId} has a playback URL`)
  say(`$ ffprobe <playback URL of ${videoId}>`)
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,bit_rate:stream=codec_type,codec_name,profile,width,height,avg_frame_rate,sample_rate',
      '-of',
      'compact',
      url
    ],
    { timeout: 120000 }
  )
  return { url, probe: stdout.trim() }
}

/** One phone, driven through maestro-d. */
export class Phone {
  readonly m: Driver
  readonly platform: 'ios' | 'android'
  constructor(m: Driver, platform: 'ios' | 'android') {
    this.m = m
    this.platform = platform
  }

  static async attach(
    device: string,
    platform: 'ios' | 'android'
  ): Promise<Phone> {
    const requireClient = createRequire(
      path.join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
    )
    const { MaestroD } = requireClient('./dist/cjs/index.js') as {
      MaestroD: {
        connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
      }
    }
    const daemon = await MaestroD.connect({
      name: required('MAESTRO_D'),
      spawn: true
    })
    const teamId = optional('TS_STREAM_TEAM_ID')
    const m = await daemon.attach({
      device,
      platform,
      appId: APP,
      ...(platform === 'ios' && teamId != null ? { teamId } : {})
    })
    return new Phone(m, platform)
  }

  async nodes(): Promise<UiNode[]> {
    return flatten(await this.m.hierarchy())
  }

  async find(
    test: (node: UiNode) => boolean,
    wait = 10000
  ): Promise<UiNode | undefined> {
    for (const until = Date.now() + wait; ;) {
      const found = (await this.nodes()).find(
        node => test(node) && node.bounds != null && node.bounds.width > 0
      )
      if (found != null) return found
      if (Date.now() > until) return undefined
      await sleep(400)
    }
  }

  /** Every text under the node with this id, joined with " · ". */
  async textsOf(id: string): Promise<string> {
    const node = (await this.nodes()).find(one => one.id === id)
    if (node == null) return ''
    const texts = flatten(node)
      .map(one => one.text ?? '')
      .filter(text => text !== '')
    // iOS repeats a view's text on its accessibility container.
    return [...new Set(texts)].join(' · ')
  }

  async shot(name: string): Promise<void> {
    const dir = optional('TS_STREAM_ARTIFACT_DIR')
    if (dir == null) return
    await mkdir(dir, { recursive: true })
    say(`$ takeScreenshot ${name}`)
    await this.m.takeScreenshot({ path: path.join(dir, name) })
  }

  async launch(): Promise<void> {
    say('$ launchApp')
    await this.m.launchApp({ appId: APP, stopApp: true })
  }

  /** Signs in through the app's own sign-in link when it shows sign-in. */
  async signInIfAsked(email: string): Promise<void> {
    if (
      (await this.find(
        node => node.text === 'Sign in to TeamStation',
        15000
      )) == null
    )
      return
    const { link } = await askToSignIn(email)
    say('$ openLink teamstation://signin/<token>')
    await this.m.openLink({ link: `teamstation://signin/${link}` })
    await sleep(3000)
    if ((await this.find(node => node.id === 'signInLinkSignIn', 3000)) != null)
      await this.m.tapOn({ id: 'signInLinkSignIn' })
    await sleep(2000)
  }

  async openGame(): Promise<void> {
    say(`$ openLink teamstation://games/${game()}`)
    await this.m.openLink({ link: `teamstation://games/${game()}` })
    assert(
      (await this.find(node => node.text === 'Box score', 30000)) != null,
      'the game opened'
    )
    await sleep(1500)
  }

  async scrollTo(element: { text: string } | { id: string }): Promise<void> {
    say(`$ scrollUntilVisible ${'text' in element ? element.text : element.id}`)
    await this.m.scrollUntilVisible({ element, centerElement: true })
  }

  /** Record video → the name → Start, then Record: on the air. */
  async recordAngle(name: string): Promise<void> {
    await this.scrollTo({ text: 'Record video' })
    say('$ tapOn Record video')
    await this.m.tapOn({ text: 'Record video' })
    assert(
      (await this.find(node => node.text === 'Name this camera angle')) != null,
      'Record video asks for the angle’s name'
    )
    // Typing a whole name through WebDriverAgent now and then drops a
    // character as the field redraws (the field's value is not in the
    // hierarchy to check): one character at a time keeps up.
    say(`$ inputText ${name} (a character at a time)`)
    for (const character of name) {
      await this.m.inputText({ text: character })
      await sleep(150)
    }
    say('$ tapOn Start')
    await this.m.tapOn({ text: 'Start' })
    assert(
      (await this.find(node => node.id === 'broadcast-button', 20000)) != null,
      'the streaming screen opened'
    )
    await sleep(1500)
    say('$ tapOn broadcast-button')
    await this.m.tapOn({ id: 'broadcast-button' })
    assert(
      (await this.find(node => node.text === 'Broadcasting', 45000)) != null,
      'the pill reads Broadcasting'
    )
  }

  /** Slide to Stop and Close, back on the game. */
  async stopAndClose(): Promise<void> {
    if ((await this.find(node => node.id === 'camera-screen', 3000)) == null)
      return
    if ((await this.find(node => node.text === 'Broadcasting', 2000)) != null) {
      say('$ tapOn broadcast-button (shows Slide to Stop)')
      await this.m.tapOn({ id: 'broadcast-button' })
      const knob = await this.find(
        node => node.id === 'slide-to-stop-knob',
        5000
      )
      const track = await this.find(
        node => node.id === 'slide-to-stop-track',
        5000
      )
      assert(
        knob?.bounds != null && track?.bounds != null,
        'Slide to Stop shows'
      )
      const y = Math.round(knob.bounds.y + knob.bounds.height / 2)
      const startX = Math.round(knob.bounds.x + knob.bounds.width / 2)
      const endX = Math.round(track.bounds.x + track.bounds.width - 4)
      say(`$ swipe ${startX},${y} → ${endX},${y}`)
      await this.m.swipe({ startX, startY: y, endX, endY: y, duration: 800 })
      assert(
        (await this.find(
          node => node.text === 'Press record to start stream',
          20000
        )) != null,
        'the stream stopped'
      )
    }
    say('$ tapOn camera-close')
    await this.m.tapOn({ id: 'camera-close' })
    assert(
      (await this.find(node => node.text === 'CAMERAS', 15000)) != null,
      'Close goes back to the game'
    )
    await sleep(1500)
  }

  async detach(): Promise<void> {
    await this.m.detach()
  }
}
