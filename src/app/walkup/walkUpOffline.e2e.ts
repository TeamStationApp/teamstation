// The iPhone's walk-up offline checks, through maestro-d's JavaScript client.
//
//   WALKUP_DEVICE_UDID=<iPhone> MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> WALKUP_ARTIFACT_DIR=<dir> \
//   WALKUP_GAME=<a game title on Home, as it reads> \
//     node -r sucrase/register src/app/walkup/walkUpOffline.e2e.ts --only <E#>
//
// E1 the clip editor's jog wheel, E4 the Apple Music walkthrough from
// Account, E5 the first DJ Game visit (the flags reset first), E6 the notice
// once, E7 the notice's Go to Settings. E2 (no DJ Game on Android) and E8
// (downloads and airplane-mode playback, which go through the Music and
// Settings apps) are run by hand, as the plan says. The phone is signed in already, as a
// songkeeper and scorekeeper of the game's team, and names no device here.
// Taps go to the point a node's bounds give, in the phone's points.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  type?: string
  text?: string
  accessibilityText?: string
  bounds?: Bounds
  children?: Node[]
}
interface Driver {
  hierarchy: () => Promise<Node>
  screenshot: () => Promise<Buffer>
  tapOn: (target: { point: string }) => Promise<unknown>
  swipe: (gesture: {
    start: string
    end: string
    duration: number
  }) => Promise<unknown>
  launchApp: (options?: { stopApp?: boolean }) => Promise<unknown>
  stopApp: () => Promise<unknown>
  eval: (script: string) => Promise<{ status: number; body: string }>
  scrollUntilVisible: (options: {
    element: { text: string }
    direction: 'DOWN' | 'UP'
  }) => Promise<unknown>
}
interface Daemon {
  info: { runDir: string }
  attach: (options: {
    device: string
    platform: 'ios'
    appId: string
  }) => Promise<Driver>
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const device = required('WALKUP_DEVICE_UDID')
const daemonName = required('MAESTRO_D')
const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
const artifacts = path.resolve(required('WALKUP_ARTIFACT_DIR'))
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? (process.argv[onlyAt + 1] ?? 'E1') : 'E1'
/** The team row on Home, and the game row on its Schedule, as they begin. */
const team = process.env.WALKUP_TEAM ?? ''
const game = process.env.WALKUP_GAME ?? ''
const APP = 'app.teamstation.app'
const READINESS = 'teamstation:walkUp:readiness'
/** The phone's height in points; the iPhone 15 Pro's. */
const SCREEN_HEIGHT = Number(process.env.WALKUP_SCREEN_HEIGHT ?? 852)
/** Where the floating tab bar begins. */
const TAB_BAR_TOP = SCREEN_HEIGHT - 120
const MANIFEST =
  'Library/Application Support/app.teamstation.app/RCTAsyncLocalStorage_V1/manifest.json'

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const labelOf = (node: Node): string =>
  node.text ?? node.accessibilityText ?? ''

async function main(): Promise<void> {
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const daemon = await MaestroD.connect({ name: daemonName, spawn: true })
  const m = await daemon.attach({ device, platform: 'ios', appId: APP })
  await mkdir(artifacts, { recursive: true })

  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const labels = async (): Promise<string[]> =>
    (await nodes()).map(labelOf).filter(label => label !== '')
  const find = async (
    label: string,
    wait = 10000,
    prefix = false,
    below = SCREEN_HEIGHT
  ): Promise<Node> => {
    for (const until = Date.now() + wait; ;) {
      const matches = (await nodes()).filter(
        node =>
          (prefix
            ? labelOf(node).startsWith(label)
            : labelOf(node) === label) &&
          node.bounds != null &&
          node.bounds.width > 0 &&
          // On screen: a list also reports the rows scrolled out of view.
          node.bounds.y >= 0 &&
          node.bounds.y + node.bounds.height / 2 < below
      )
      // A row is found by how it begins, as listed. An exact label takes
      // the smallest match: a scrim shares the label of the button on it.
      const area = (node: Node): number =>
        node.bounds!.width * node.bounds!.height
      const found = prefix
        ? matches[0]
        : matches.sort((a, b) => area(a) - area(b))[0]
      if (found != null) return found
      if (Date.now() > until) throw new Error(`Nothing labelled ${label}`)
      await sleep(500)
    }
  }
  const centre = (bounds: Bounds): string =>
    `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
  const tap = async (
    label: string,
    settle = 1500,
    prefix = false,
    below = SCREEN_HEIGHT
  ): Promise<void> => {
    const node = await find(label, 10000, prefix, below)
    await m.tapOn({ point: centre(node.bounds!) })
    await sleep(settle)
  }
  const shows = async (text: string): Promise<boolean> =>
    (await labels()).some(label => label.includes(text))
  const shot = async (name: string): Promise<void> => {
    await writeFile(path.join(artifacts, name), await m.screenshot())
    console.log(`Captured ${name}`)
  }
  // A drag goes to WebDriverAgent as W3C pointer actions: a finger that
  // presses, pauses and moves in steps. maestro-d's swipe is a flick that
  // React Native's responders never see as a drag.
  const driverLog = await readFile(
    path.join(daemon.info.runDir, 'daemon.log'),
    'utf8'
  )
  const port = driverLog
    .split('\n')
    .filter(line => line.includes(`Starting WDA on device ${device} (port:`))
    .at(-1)
    ?.match(/\(port: (\d+)\)/)?.[1]
  assert(port != null, 'This device’s WebDriverAgent port is in the daemon log')
  const wda = `http://127.0.0.1:${port}`
  const dragAt = async (x: number, y: number, dx: number): Promise<void> => {
    const status = await m.eval(`http.get(${JSON.stringify(`${wda}/status`)})`)
    const { sessionId } = JSON.parse(status.body) as { sessionId: string }
    const steps: Array<Record<string, unknown>> = [
      { type: 'pointerMove', duration: 0, x, y, origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 150 }
    ]
    for (let i = 1; i <= 12; i++) {
      steps.push({
        type: 'pointerMove',
        duration: 160,
        x: Math.round(x + (dx * i) / 12),
        y,
        origin: 'viewport'
      })
    }
    steps.push(
      { type: 'pause', duration: 150 },
      { type: 'pointerUp', button: 0 }
    )
    const body = JSON.stringify({
      actions: [
        {
          type: 'pointer',
          id: 'finger',
          parameters: { pointerType: 'touch' },
          actions: steps
        }
      ]
    })
    const sent = await m.eval(
      `http.post(${JSON.stringify(`${wda}/session/${sessionId}/actions`)}, {body:${JSON.stringify(body)}})`
    )
    assert.equal(sent.status, 200, sent.body)
    await sleep(800)
  }
  /** A horizontal drag of `dx` points from left of a node's middle. */
  const drag = async (label: string, dx: number): Promise<void> => {
    const { bounds } = await find(label)
    await dragAt(
      Math.round(bounds!.x + bounds!.width / 2 - dx / 2),
      Math.round(bounds!.y + bounds!.height / 2),
      dx
    )
  }
  const readout = async (which: 'Start' | 'End'): Promise<number> => {
    const all = await nodes()
    const label = all.find(node => labelOf(node) === which)
    assert(label?.bounds != null, `${which} readout`)
    const value = all.find(
      node =>
        node.bounds != null &&
        /^\d+:\d\d\.\d$/.test(labelOf(node)) &&
        Math.abs(node.bounds.y - label.bounds!.y) < 6
    )
    assert(value != null, `${which} value`)
    const [minutes, rest] = labelOf(value).split(':')
    return Math.round((Number(minutes) * 60 + Number(rest)) * 1000)
  }

  /** `xcrun devicectl device <command…> --device <udid> <args…>`. */
  const devicectl = (command: string[], args: string[] = []): string =>
    execFileSync(
      'xcrun',
      ['devicectl', 'device', ...command, '--device', device, ...args],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString()
  /**
   * Ends the app's process. maestro-d's `stopApp` on this driver, and
   * `devicectl process terminate`, leave it running, so a "relaunch" would
   * bring back the same page and its visit; SIGKILL ends it for real.
   */
  const kill = async (): Promise<void> => {
    const list = path.join(tmpdir(), `walkUpOffline-procs-${process.pid}.json`)
    devicectl(['info', 'processes'], ['--json-output', list])
    const { result } = JSON.parse(await readFile(list, 'utf8')) as {
      result: {
        runningProcesses: Array<{
          processIdentifier: number
          executable?: string
        }>
      }
    }
    const app = result.runningProcesses.find(
      entry => entry.executable?.includes('/TeamStation.app/') === true
    )
    if (app != null) {
      devicectl(
        ['process', 'signal'],
        ['--pid', String(app.processIdentifier), '--signal', 'SIGKILL']
      )
      await sleep(1500)
    }
  }
  /** Removes the readiness flags, or only `promptShown`, with the app stopped. */
  const resetFlags = async (which: 'all' | 'promptShown'): Promise<void> => {
    await kill()
    const local = path.join(tmpdir(), `walkUpOffline-${process.pid}.json`)
    const copy = (direction: 'from' | 'to'): void => {
      execFileSync('xcrun', [
        'devicectl',
        'device',
        'copy',
        direction,
        '--device',
        device,
        '--domain-type',
        'appDataContainer',
        '--domain-identifier',
        APP,
        '--source',
        direction === 'from' ? MANIFEST : local,
        '--destination',
        direction === 'from' ? local : MANIFEST
      ])
    }
    copy('from')
    // The manifest holds the session; only the readiness entry changes, and
    // nothing of it is printed.
    const manifest = new Map(
      Object.entries(
        JSON.parse(await readFile(local, 'utf8')) as Record<string, string>
      )
    )
    const held = manifest.get(READINESS)
    if (which === 'all') manifest.delete(READINESS)
    else if (held != null) {
      const flags = JSON.parse(held) as Record<string, unknown>
      manifest.set(READINESS, JSON.stringify({ ...flags, promptShown: false }))
    }
    await writeFile(local, JSON.stringify(Object.fromEntries(manifest)))
    copy('to')
    await writeFile(local, '')
    console.log(`Reset readiness flags: ${which}`)
  }

  const home = async (): Promise<void> => {
    for (let i = 0; i < 4 && !(await shows('Your Home')); i++) {
      // The tab bar's Home, not a team pill's "Home" above it.
      const tab = (await nodes()).find(
        node =>
          labelOf(node) === 'Home' && node.bounds != null && node.bounds.y > 700
      )
      if (tab?.bounds != null) await m.tapOn({ point: centre(tab.bounds) })
      await sleep(1500)
    }
    assert(await shows('Your Home'), 'Home is showing')
  }

  /** Home › the team › Schedule › the game › DJ Game. */
  const openDj = async (): Promise<void> => {
    assert(
      team !== '' && game !== '',
      'WALKUP_TEAM and WALKUP_GAME are required'
    )
    await home()
    await tap(team, 3000, true)
    // The team's own Schedule section, not the tab bar's Schedule.
    await tap('Schedule', 2500, false, TAB_BAR_TOP)
    await tap(game, 4000, true)
    await tap('Record', 5000)
  }
  const leave = async (): Promise<void> => {
    await tap('Back', 1500)
  }
  const relaunch = async (): Promise<void> => {
    await kill()
    devicectl(['process', 'launch'], [APP])
    await sleep(7000)
  }
  const onboarding = async (): Promise<boolean> =>
    await shows('TeamStation DJ, enable the following')
  const notice = async (): Promise<boolean> =>
    await shows('Some walk-up songs still need to be downloaded')
  /** Adding a game's songs can take minutes; the notice follows it. */
  const awaitNotice = async (wait = 180000): Promise<boolean> => {
    for (const until = Date.now() + wait; Date.now() < until;) {
      if (await notice()) return true
      await sleep(3000)
    }
    return false
  }

  const scenarios: Record<string, () => Promise<void>> = {
    async E1() {
      await relaunch()
      await openDj()
      // The away side's pill, under its "Away" label: the test team's side.
      const away = await find('Away')
      await m.tapOn({
        point: `${Math.round(away.bounds!.x + away.bounds!.width / 2)},${Math.round(away.bounds!.y + 31)}`
      })
      await sleep(2000)
      // The first batter with a song: its picker opens on the clip.
      await tap('Set ', 4000, true)
      const jog = await find('Fine adjust: drag to move the clip slowly')
      const startLabel = await find('Start')
      const timelineTop = startLabel.bounds!.y
      const jogTop = jog.bounds!.y
      assert(timelineTop < jogTop, 'the times sit above the wheel')
      await shot('clip-editor-after.png')
      const before = await readout('Start')
      await drag('Fine adjust: drag to move the clip slowly', 160)
      const jogged = (await readout('Start')) - before
      // Back to the start, then the same move on the timeline, a quarter as far.
      await leave()
      await tap('Set ', 4000, true)
      const again = await readout('Start')
      assert.equal(again, before, 'nothing was saved')
      const wheel = await find('Fine adjust: drag to move the clip slowly')
      const y = Math.round(wheel.bounds!.y - 16 - 24)
      const x = Math.round(wheel.bounds!.x + wheel.bounds!.width / 2 - 20)
      await dragAt(x, y, 40)
      const slid = (await readout('Start')) - before
      console.log(
        `E1: Start ${before} ms; the wheel moved it ${jogged} ms over 160 pt, the timeline ${slid} ms over 40 pt`
      )
      assert(jogged > 0 && slid > 0, 'both moved the clip')
      assert(Math.abs(jogged - slid) <= 400, 'the wheel is a quarter as fast')
      await leave()
      console.log('E1 passed')
    },
    async E5() {
      await resetFlags('all')
      await relaunch()
      await openDj()
      await sleep(3000)
      assert(await onboarding(), 'the walkthrough opened by itself')
      assert(!(await notice()), 'no notice behind it')
      await shot('dj-first-visit-onboarding.png')
      await tap('Close')
      assert(!(await onboarding()), 'closed')
      console.log('E5 passed')
    },
    async E6() {
      await resetFlags('promptShown')
      await relaunch()
      await openDj()
      assert(await awaitNotice(), 'the notice for songs still waiting')
      assert(!(await onboarding()), 'no walkthrough once closed')
      await shot('songs-modal.png')
      await tap('Ignore')
      assert(!(await notice()), 'Ignore closed it')
      await leave()
      await tap('Record', 5000)
      assert(!(await awaitNotice(60000)), 'once per device')
      console.log('E6 passed')
    },
    async E7() {
      await resetFlags('promptShown')
      await relaunch()
      await openDj()
      assert(await awaitNotice(), 'the notice again')
      await tap('Go to Settings', 3000)
      assert(!(await notice()), 'the notice went')
      assert(await onboarding(), 'the walkthrough followed it')
      await shot('modal-to-onboarding.png')
      await tap('Close')
      console.log('E7 passed')
    },
    async E4() {
      await relaunch()
      await home()
      await tap('Account, ', 2500, true)
      await m.scrollUntilVisible({
        element: { text: 'Sign out' },
        direction: 'DOWN'
      })
      await sleep(1000)
      await shot('account-walkup-after.png')
      await tap('Apple Music settings')
      assert(await shows('TeamStation DJ, enable the following'), 'page 1')
      await shot('onboarding-1.png')
      await tap('Next')
      assert(await shows('Settings › Apps › Music'), 'page 2')
      await shot('onboarding-2.png')
      await tap('Next')
      assert(await shows('don’t download by themselves'), 'page 3')
      await shot('onboarding-3.png')
      await tap('Back')
      assert(!(await shows('don’t download by themselves')), 'back to 2')
      await tap('Next')
      await tap('Go to Settings', 3000)
      assert(!(await shows('Settings › Apps › Music')), 'Settings opened')
      await m.launchApp()
      await sleep(2500)
      await tap('Done')
      assert(!(await shows('Settings › Apps › Music')), 'Done closed it')
      await tap('Apple Music settings')
      await tap('Close')
      assert(
        !(await shows('TeamStation DJ, enable the following')),
        'Close closed it'
      )
      console.log('E4 passed')
    }
  }
  const run = scenarios[only]
  assert(run != null, `No scenario ${only}`)
  try {
    await run()
  } catch (error) {
    await shot(`failure-${only}.png`).catch(() => undefined)
    throw error
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
