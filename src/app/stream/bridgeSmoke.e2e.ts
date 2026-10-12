// E10, the bridge smoke test: the streaming TurboModule and preview are in
// the build, and the native modules the codegen change touched still answer.
// Through maestro-d's JavaScript client, on an iOS simulator or iPhone, or
// on an Android phone with TS_STREAM_ANDROID_SERIAL in place of the UDID.
//
//   TS_STREAM_IOS_UDID=<device> | TS_STREAM_ANDROID_SERIAL=<adb serial> \
//   MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   [TS_STREAM_TEAM_ID=<WebDriverAgent signing team, for a real device>] \
//   [TS_STREAM_RELEASE_BUILD=1] \
//   TS_STREAM_API=http://<LAN address>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_EMAIL=<a seeded user> TS_STREAM_GAME=<a game with two videos> \
//   TS_STREAM_WALKUP_PLAYER=<teamId>/<userId> [TS_STREAM_TOKEN=<session>] \
//   [TS_STREAM_WALKUP_SEARCH=<on Android, the start of a music file's title>] \
//   [TS_STREAM_ARTIFACT_DIR=<dir>] \
//     node -r sucrase/register src/app/stream/bridgeSmoke.e2e.ts
//
// The server runs locally without mail, so it logs each sign-in code and
// link; the app is signed in through its own `teamstation://signin/` link.
// Its `dictation` block may hold a placeholder key: the button only has to
// show, and the microphone opens before anything is sent. The player gets a
// placeholder Apple Music song through the API, so the walk-up screen has a
// clip to play and a jog wheel to turn.
//
//   1. The game's Videos tab offers Record video.
//   2. The walk-up module reports on the song, and its preview is asked to
//      play; dictation's microphone is asked to start. Each must be answered
//      by its native module: playing or a refusal in the module's own words.
//      A simulator has neither Apple Music nor a microphone input, so there
//      the answer is the refusal.
//   3. The jog wheel's haptics are requested and raise no error. Only a
//      Debug build logs the request, so with TS_STREAM_RELEASE_BUILD=1 the
//      wheel moving the clip stands in for it.
//   On Android, which has no DJ Game, 2 and 3 run on the player's walk-up
//   song screen with a music file already on the phone: its preview must
//   play, and the jog wheel must move the clip and play touch haptics, which
//   the vibrator service lists. The song is not saved.
//   4. All angles: the multi-camera view turns with the device.
import assert from 'node:assert/strict'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

import { lstrings } from '../locales/strings'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  id?: string
  text?: string
  accessibilityText?: string
  resourceId?: string
  bounds?: Bounds
  children?: Node[]
}
interface Driver {
  hierarchy: () => Promise<Node>
  screenshot: () => Promise<Buffer>
  launchApp: (options?: { stopApp?: boolean }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (
    target: { text: string } | { id: string } | { point: string }
  ) => Promise<unknown>
  swipe: (gesture: {
    start: string
    end: string
    duration: number
  }) => Promise<unknown>
  setOrientation: (orientation: string) => Promise<unknown>
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
const run = promisify(execFile)
const adb = async (...args: string[]): Promise<string> =>
  (await run('adb', ['-s', device, ...args])).stdout
const daemonName = required('MAESTRO_D')
const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
const api = required('TS_STREAM_API').replace(/\/$/, '')
const serverLog = required('TS_STREAM_SERVER_LOG')
const email = required('TS_STREAM_EMAIL')
const game = required('TS_STREAM_GAME')
const [walkUpTeam, walkUpPlayer] = required('TS_STREAM_WALKUP_PLAYER').split(
  '/'
)
// On Android, the start of a music file's title on the phone, for the preview.
const walkUpSearch = android ? required('TS_STREAM_WALKUP_SEARCH') : ''
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const teamId = process.env.TS_STREAM_TEAM_ID
const releaseBuild = process.env.TS_STREAM_RELEASE_BUILD === '1'
const APP = 'app.teamstation.app'

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const say = (line: string): void => {
  console.log(`${new Date().toISOString()} ${line}`)
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const labelOf = (node: Node): string =>
  node.text ?? node.accessibilityText ?? ''
// Android names a view's testID as its resource id, which maestro-d calls `id`.
const idOf = (node: Node): string | undefined => node.resourceId ?? node.id
const centre = (bounds: Bounds): string =>
  `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`

/** A simulator's id is a UUID; a phone's hardware UDID is not. */
const isSimulator =
  !android &&
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(device)

/**
 * The app's JavaScript console and native log lines, as the device logs them:
 * an Android phone's through `adb logcat`, a simulator's through `simctl`, a
 * USB-attached iPhone's through pymobiledevice3's syslog relay (run with
 * `uvx`), since macOS's own `log` reads a phone only as root.
 */
function deviceLog(): {
  lines: string[]
  since: () => number
  stop: () => void
} {
  const lines: string[] = []
  const child: ChildProcess = android
    ? spawn('adb', ['-s', device, 'logcat', '-T', '1', '-v', 'brief'], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
    : isSimulator
      ? spawn(
          'xcrun',
          [
            'simctl',
            'spawn',
            device,
            'log',
            'stream',
            '--level',
            'debug',
            '--style',
            'compact',
            '--predicate',
            'process == "TeamStation"'
          ],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        )
      : spawn(
          'uvx',
          [
            'pymobiledevice3',
            'syslog',
            'live',
            '--udid',
            device,
            '--process-name',
            'TeamStation'
          ],
          {
            stdio: ['ignore', 'pipe', 'ignore'],
            // Python buffers a pipe; the lines are wanted as they come.
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
          }
        )
  let rest = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = rest + chunk.toString()
    const split = text.split('\n')
    rest = split.pop() ?? ''
    lines.push(...split)
  })
  return {
    lines,
    since: () => lines.length,
    stop: () => {
      child.kill()
    }
  }
}

/** Waits for a log line matching `pattern` after line `from`. */
async function logLine(
  log: { lines: string[] },
  pattern: RegExp,
  from: number,
  wait = 15000
): Promise<string | undefined> {
  for (const until = Date.now() + wait; Date.now() < until;) {
    const found = log.lines.slice(from).find(line => pattern.test(line))
    if (found != null) return found
    await sleep(300)
  }
  return undefined
}

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

const post = async (
  route: string,
  body: unknown,
  token?: string
): Promise<Response> =>
  await fetch(`${api}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token == null ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify(body)
  })

/** Asks for a sign-in mail; the local server logs its code and link instead. */
async function askToSignIn(): Promise<{ code: string; link: string }> {
  const offset = (await readFile(serverLog, 'utf8')).length
  const asked = await post('/auth/email-code', { email })
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

/**
 * A session token for the API calls the test makes itself: `TS_STREAM_TOKEN`
 * when given, since the server allows five codes an address a quarter hour.
 */
async function apiToken(): Promise<string> {
  const given = process.env.TS_STREAM_TOKEN
  if (given != null && given !== '') return given
  const { code } = await askToSignIn()
  const verified = await post('/auth/email-code/verify', { email, code })
  assert.equal(verified.status, 200, 'the sign-in code was accepted')
  return ((await verified.json()) as { token: string }).token
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
    ...(teamId == null || android ? {} : { teamId })
  })
  const log = deviceLog()
  const results: string[] = []
  if (artifacts != null) await mkdir(artifacts, { recursive: true })

  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const find = async (
    label: string,
    wait = 10000,
    prefix = false
  ): Promise<Node | undefined> => {
    for (const until = Date.now() + wait; ;) {
      const found = (await nodes())
        .filter(
          node =>
            (prefix
              ? labelOf(node).startsWith(label)
              : labelOf(node) === label || idOf(node) === label) &&
            node.bounds != null &&
            node.bounds.width > 0
        )
        .sort(
          (a, b) =>
            a.bounds!.width * a.bounds!.height -
            b.bounds!.width * b.bounds!.height
        )[0]
      if (found != null) return found
      if (Date.now() > until) return undefined
      await sleep(500)
    }
  }
  const tap = async (label: string, settle = 1500): Promise<void> => {
    const node = await find(label)
    assert(node?.bounds != null, `Nothing labelled ${label}`)
    say(`$ tapOn ${label}`)
    await m.tapOn({ point: centre(node.bounds) })
    await sleep(settle)
  }
  const shot = async (name: string): Promise<void> => {
    if (artifacts == null) return
    await writeFile(path.join(artifacts, `${name}.png`), await m.screenshot())
  }
  const openGame = async (): Promise<void> => {
    say(`$ openLink teamstation://games/${game}?tab=watch`)
    await m.openLink({ link: `teamstation://games/${game}?tab=watch` })
    assert((await find('Box score', 30000)) != null, 'the game opened')
  }

  try {
    say('$ launchApp')
    await m.launchApp({ stopApp: true })
    if ((await find('Sign in to TeamStation', 15000)) != null) {
      const { link } = await askToSignIn()
      say('$ openLink teamstation://signin/<token>')
      await m.openLink({ link: `teamstation://signin/${link}` })
      await sleep(3000)
      if ((await find('signInLinkSignIn', 3000)) != null)
        await tap('signInLinkSignIn')
    }

    // 1. Record video, which the Videos tab offers once the module says
    // this phone can record.
    await openGame()
    if (android) {
      // Android's hierarchy holds only what is on the screen. Swipe below the
      // player, which would take a swipe across it for itself.
      for (
        let i = 0;
        i < 8 && (await find('Record video', 1000)) == null;
        i++
      ) {
        say('$ swipe 50%,78% → 50%,30%')
        await m.swipe({ start: '50%, 78%', end: '50%, 30%', duration: 600 })
        await sleep(800)
      }
    }
    assert(
      (await find('Record video', 10000)) != null,
      'the Videos tab offers Record video'
    )
    results.push('1 Videos tab offers Record video')
    await shot('bridge-smoke-videos')

    // DJ Game is offered on an iPhone only (makeWalkUpMusic: djSupported is
    // platform === 'ios'), so on Android the preview and the jog wheel are the
    // player page's walk-up song screen, with a music file on the phone.
    if (android) {
      // 2a. The walk-up module: the phone's music searched, then a preview.
      const link = `teamstation://players/${walkUpPlayer}?onTeam=${walkUpTeam}&tab=walkup`
      say(`$ openLink ${link}`)
      await m.openLink({ link })
      const edit =
        (await find(lstrings.player_walkup_set, 15000)) ??
        (await find(lstrings.player_walkup_change, 1000))
      assert(edit?.bounds != null, 'the Walk-up tab offers Set or Change')
      say(`$ tapOn ${labelOf(edit)}`)
      await m.tapOn({ point: centre(edit.bounds) })
      await sleep(2000)
      if ((await find(lstrings.walkup_pick_another, 2000)) != null)
        await tap(lstrings.walkup_pick_another, 2000)
      await tap(lstrings.walkup_search_device, 1000)
      say(`$ inputText ${walkUpSearch}`)
      await adb('shell', 'input', 'text', walkUpSearch.replace(/ /g, '%s'))
      await sleep(1000)
      let found: Node | undefined
      for (const until = Date.now() + 15000; Date.now() < until;) {
        found = (await nodes()).find(
          node =>
            labelOf(node).startsWith(walkUpSearch) &&
            labelOf(node) !== walkUpSearch &&
            node.bounds != null
        )
        if (found != null) break
        await sleep(500)
      }
      assert(
        found?.bounds != null,
        `the phone's music lists a song starting "${walkUpSearch}"`
      )
      say(`$ tapOn ${labelOf(found)}`)
      await m.tapOn({ point: centre(found.bounds) })
      assert(
        (await find(lstrings.walkup_jog, 10000)) != null,
        'the song opens in the clip editor'
      )
      const beforePlay = log.since()
      await tap(lstrings.walkup_play, 0)
      const played = await logLine(
        log,
        /WalkUpMusicState \{.*"kind":"(playing|error)"|WalkUpMusic (play|search) failed/,
        beforePlay,
        8000
      )
      assert(played != null, 'the walk-up module answered the preview')
      assert(
        played.includes('"kind":"playing"'),
        `the preview plays: ${played}`
      )
      results.push(
        `2 walk-up preview: ${played.slice(played.indexOf('WalkUpMusicState'))}`
      )
      await sleep(1500)
      await shot('bridge-smoke-walkup-preview')
      await tap(lstrings.player_walkup_stop, 1000)

      // 3. The jog wheel's haptics: the vibrator service lists each effect
      // the app plays, so the new TOUCH effects are the jog wheel's.
      const jog = await find(lstrings.walkup_jog, 5000)
      assert(jog?.bounds != null, 'the clip editor has its jog wheel')
      const clipStart = async (): Promise<string> =>
        (await nodes()).find(node => idOf(node) === 'walkup-start')?.text ?? ''
      const effects = async (): Promise<string[]> =>
        (await adb('shell', 'dumpsys', 'vibrator_manager'))
          .split('\n')
          .filter(
            line =>
              line.includes('usage: TOUCH') && line.includes(`${APP} (uid=`)
          )
          .map(line => line.trim())
      const startBefore = await clipStart()
      const effectsBefore = new Set(await effects())
      const beforeJog = log.since()
      const y = Math.round(jog.bounds.y + jog.bounds.height / 2)
      const x = Math.round(jog.bounds.x + jog.bounds.width * 0.3)
      const x2 = Math.round(jog.bounds.x + jog.bounds.width * 0.7)
      say(`$ drag the jog wheel ${x},${y} → ${x2},${y}`)
      await adb(
        'shell',
        'input',
        'swipe',
        `${x}`,
        `${y}`,
        `${x2}`,
        `${y}`,
        '1200'
      )
      await sleep(1500)
      const startAfter = await clipStart()
      const played2 = (await effects()).filter(line => !effectsBefore.has(line))
      const hapticError = log.lines
        .slice(beforeJog)
        .find(line =>
          /TSHaptics.*(error|exception)|Unhandled.*Haptic|FATAL EXCEPTION/i.test(
            line
          )
        )
      assert(hapticError == null, `haptics raised ${hapticError}`)
      assert.notEqual(startAfter, startBefore, 'the jog wheel moved the clip')
      assert(played2.length > 0, 'the jog wheel played touch haptics')
      // Each effect's status: finished, or cancelled_superseded when the
      // wheel's next tick came first.
      const statuses = new Map<string, number>()
      for (const line of played2) {
        const status = line.split('|')[2]?.trim() ?? '?'
        statuses.set(status, (statuses.get(status) ?? 0) + 1)
      }
      const counted = [...statuses].map(([status, n]) => `${n} ${status}`)
      results.push(
        `3 haptics: ${played2.length} TOUCH effects from the jog wheel (${counted.join(', ')}); the clip start ${startBefore} → ${startAfter}`
      )
      await shot('bridge-smoke-walkup-jog')
      // Leave without saving: the player's song stays as it was.
      await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
      await sleep(1000)
    } else {
      // 2a. The walk-up module: a song to report on, then its preview.
      const token = await apiToken()
      const song = await fetch(
        `${api}/teams/${walkUpTeam}/players/${walkUpPlayer}/walk-up-song`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            provider: 'appleMusic',
            providerId: '1000000001',
            isrc: null,
            title: 'Bridge Smoke',
            artist: 'TeamStation Test',
            album: null,
            artworkUrl: null,
            durationMs: 180000,
            startMs: 30000,
            endMs: 45000
          })
        }
      )
      assert.equal(song.status, 200, 'the walk-up song was set')
      const beforeDj = log.since()
      await tap('DJ Game', 3000)
      // The first visit's Apple Music walkthrough, closed from its last page.
      let walked = false
      for (let page = 0; page < 6; page++) {
        if ((await find('Next', 1500)) == null) break
        walked = true
        await tap('Next', 800)
      }
      if (walked) {
        say('$ tapOn the walkthrough’s close button')
        await m.tapOn({ point: '90%,9%' })
      }
      assert(
        (await find('Bridge Smoke', 15000, true)) != null,
        'the song is listed'
      )
      const reported = await logLine(log, /WalkUpMusicState \{/, beforeDj)
      assert(reported != null, 'the walk-up module reported on the songs')
      results.push(
        `2 walk-up module: ${reported.slice(reported.indexOf('WalkUpMusicState'))}`
      )
      // The row's preview button: "Play <player>’s walk-up song".
      const beforePlay = log.since()
      const play = (await nodes()).find(
        node =>
          /^Play .*walk-up song$/.test(labelOf(node)) && node.bounds != null
      )
      assert(play?.bounds != null, 'the song offers a preview')
      say(`$ tapOn ${labelOf(play)}`)
      await m.tapOn({ point: centre(play.bounds) })
      const played = await logLine(
        log,
        /WalkUpMusicState \{"kind":"(playing|error)"|WalkUpMusic (play|search) failed/,
        beforePlay,
        8000
      )
      results.push(
        played == null
          ? '2 walk-up preview: asked, no answer (the song is not on this device, so the preview is off)'
          : `2 walk-up preview: ${played.slice(played.indexOf('WalkUpMusic'))}`
      )

      // 3. The jog wheel's haptics: requested, and no error.
      const row = await find('Bridge Smoke', 5000, true)
      assert(row?.bounds != null, 'the song is listed')
      say('$ tapOn the song')
      await m.tapOn({ point: centre(row.bounds) })
      await sleep(3000)
      const jog = await find(lstrings.walkup_jog, 10000)
      assert(jog?.bounds != null, 'the clip editor has its jog wheel')
      const clipStart = async (): Promise<string> =>
        (await nodes()).find(node => node.id === 'walkup-start')?.text ?? ''
      const startBefore = await clipStart()
      const beforeJog = log.since()
      const wdaPort = (
        await readFile(path.join(daemon.info.runDir, 'daemon.log'), 'utf8')
      )
        .split('\n')
        .filter(line =>
          line.includes(`Starting WDA on device ${device} (port:`)
        )
        .at(-1)
        ?.match(/\(port: (\d+)\)/)?.[1]
      assert(
        wdaPort != null,
        'this device’s WebDriverAgent port is in the daemon log'
      )
      const wda = `http://127.0.0.1:${wdaPort}`
      const status = await m.eval(
        `http.get(${JSON.stringify(`${wda}/status`)})`
      )
      const { sessionId } = JSON.parse(status.body) as { sessionId: string }
      const x = Math.round(jog.bounds.x + jog.bounds.width / 2 - 80)
      const y = Math.round(jog.bounds.y + jog.bounds.height / 2)
      const steps: Array<Record<string, unknown>> = [
        { type: 'pointerMove', duration: 0, x, y, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 150 }
      ]
      for (let i = 1; i <= 12; i++)
        steps.push({
          type: 'pointerMove',
          duration: 160,
          x: Math.round(x + (160 * i) / 12),
          y,
          origin: 'viewport'
        })
      steps.push({ type: 'pointerUp', button: 0 })
      say('$ drag the jog wheel 160 pt')
      const dragged = await m.eval(
        `http.post(${JSON.stringify(`${wda}/session/${sessionId}/actions`)}, {body:${JSON.stringify(
          JSON.stringify({
            actions: [
              {
                type: 'pointer',
                id: 'finger',
                parameters: { pointerType: 'touch' },
                actions: steps
              }
            ]
          })
        )}})`
      )
      assert.equal(dragged.status, 200, dragged.body)
      const haptic = await logLine(
        log,
        /TSHaptics light request/,
        beforeJog,
        8000
      )
      const hapticError = log.lines
        .slice(beforeJog)
        .find(line =>
          /TSHaptics.*(error|exception)|Unhandled.*Haptic/i.test(line)
        )
      assert(hapticError == null, `haptics raised ${hapticError}`)
      if (haptic != null) {
        results.push('3 haptics: TSHaptics light request, no error')
      } else {
        assert(
          releaseBuild,
          'the jog wheel asked for light haptics (a Release build logs no request: set TS_STREAM_RELEASE_BUILD=1)'
        )
        const startAfter = await clipStart()
        assert.notEqual(startAfter, startBefore, 'the jog wheel moved the clip')
        results.push(
          `3 haptics: no error; the jog wheel moved the clip start ${startBefore} → ${startAfter} (a Release build logs no TSHaptics request)`
        )
      }
    }

    // 2b. Dictation's microphone.
    await openGame()
    await tap('Score Game', 2000)
    await tap('Full game scoring', 5000)
    const beforeDictation = log.since()
    await tap('Dictation', 0)
    // Started, the audio engine logs its start. Refused, as on a simulator,
    // which has no input, the engine logs why, and the module's own words
    // ("This phone has no microphone") show on the screen for a moment.
    let refused: string | undefined
    let started: string | undefined
    let noInput: string | undefined
    for (const until = Date.now() + 15000; Date.now() < until;) {
      refused ??= (await nodes())
        .map(labelOf)
        .find(label => label.startsWith('The microphone is not available'))
      const lines = log.lines.slice(beforeDictation)
      if (android) {
        // The audio service lists each app recording now.
        const audio = await adb('shell', 'dumpsys', 'audio').catch(() => '')
        started ??= audio
          .split('\n')
          .find(
            line =>
              /rec|Record/i.test(line) && line.includes('app.teamstation.app')
          )
          ?.trim()
        noInput ??= lines.find(line => line.includes('DictationMicrophone'))
        if (started != null || (noInput != null && refused != null)) break
        await sleep(250)
        continue
      }
      // A phone's syslog relay does not always carry the engine's lines; the
      // audio session switching to record (the module's first step) stands
      // in for them there, unless the module refused.
      started =
        lines.find(line =>
          /AVAudioEngine\.mm.*: (start\b|initialize\b|stop, was running 1)/.test(
            line
          )
        ) ??
        (isSimulator || refused != null
          ? undefined
          : lines.find(line =>
              /RouteChangeReasonCategoryChange|PrefersToInterruptActiveRecordingSessions/.test(
                line
              )
            ))
      noInput = lines.find(line =>
        /associating with audio session .*error -?\d+/.test(line)
      )
      if (started != null || (noInput != null && refused != null)) break
      await sleep(250)
    }
    if (!android && started != null && !started.includes('AVAudioEngine')) {
      // The session switches before the module can refuse: give a refusal
      // time to show.
      await sleep(3000)
      refused ??= (await nodes())
        .map(labelOf)
        .find(label => label.startsWith('The microphone is not available'))
      if (refused != null) started = undefined
    }
    assert(
      started != null || noInput != null,
      `the dictation microphone was asked to start${refused == null ? '' : `: "${refused}"`}`
    )
    const startedDetail =
      started == null
        ? ''
        : android
          ? `dumpsys audio: ${started.slice(0, 200)}`
          : started.slice(Math.max(0, started.indexOf('>: ') + 3))
    results.push(
      started != null
        ? `2 dictation: the microphone started (${startedDetail.replace(/\s+/g, ' ')})`
        : `2 dictation: the native module was asked to start and refused (${noInput?.slice(noInput.indexOf('associating')) ?? ''})${refused == null ? '' : `: "${refused}"`}`
    )
    await shot('bridge-smoke-dictation')

    // 4. The multi-camera view turns with the device.
    await openGame()
    // The angle buttons scroll sideways; All angles is the last of them.
    const screenWidth = (await m.hierarchy()).bounds?.width ?? 390
    const shown = async (): Promise<boolean> => {
      const button = await find('All angles', 1000)
      return (
        button?.bounds != null &&
        button.bounds.x + button.bounds.width <= screenWidth
      )
    }
    for (let i = 0; i < 4 && !(await shown()); i++) {
      await m.swipe({ start: '85%, 68%', end: '10%, 68%', duration: 500 })
      await sleep(500)
    }
    await tap('All angles')
    await tap('Watch', 3000)
    const extent = async (): Promise<{ width: number; height: number }> => {
      const all = (await nodes()).filter(node => node.bounds != null)
      return {
        width: Math.max(
          ...all.map(node => node.bounds!.x + node.bounds!.width)
        ),
        height: Math.max(
          ...all.map(node => node.bounds!.y + node.bounds!.height)
        )
      }
    }
    // On a phone, WebDriverAgent's orientation stands in for the phone's own
    // and stays as an earlier run left it: start upright.
    say('$ setOrientation PORTRAIT')
    await m.setOrientation('PORTRAIT')
    await sleep(2000)
    const portrait = await extent()
    say('$ setOrientation LANDSCAPE_LEFT')
    await m.setOrientation('LANDSCAPE_LEFT')
    await sleep(3000)
    const landscape = await extent()
    await shot('bridge-smoke-multicam-landscape')
    say('$ setOrientation PORTRAIT')
    await m.setOrientation('PORTRAIT')
    await sleep(2000)
    assert(portrait.height > portrait.width, 'upright first')
    assert(
      landscape.width > landscape.height,
      `the multi-camera view turned: ${JSON.stringify({ portrait, landscape })}`
    )
    results.push(
      `4 multi-camera view: ${portrait.width}x${portrait.height} upright, ${landscape.width}x${landscape.height} sideways`
    )
  } finally {
    log.stop()
    if (artifacts != null)
      await writeFile(
        path.join(artifacts, 'bridge-smoke-device.log'),
        log.lines.join('\n')
      )
    await m.detach()
  }
  for (const line of results) say(`PASS ${line}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
