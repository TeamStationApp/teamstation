// Run with node -r sucrase/register. Drives the real phone app's roster editor
// against a local fixture API that serves game g1 with 14 players a side.
// Required env: TEST_PLATFORM (ios or android), TEST_DEVICE, MAESTRO_D,
// MAESTRO_D_CLIENT_ROOT, TEST_ARTIFACT_DIR, TEST_PHASE (before or after), and
// TEST_TEAM_ID for a physical iPhone (not a simulator). TEST_SIMULATOR=1 on an
// iOS simulator also screenshots D1 mid-drag, while the finger rests at the
// drop point, through simctl (a gesture call blocks the driver until it ends). TEST_ONLY lists the scenarios to run (default all).
// `before` captures and logs without asserting. Never point it at a live
// service: nothing here is saved, but the editor reads real rosters.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { ROSTER_CARD_GAP } from './rosterLayout'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Element {
  text?: string
  accessibilityText?: string
  enabled?: boolean
  bounds?: Bounds
  children?: Element[]
}
interface Device {
  hierarchy: () => Promise<Element>
  tapOn: (selector: {
    text?: string
    enabled?: boolean
    timeout?: number
  }) => Promise<unknown>
  assertVisible: (selector: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  stopApp: (options: { appId: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  eval: (script: string) => Promise<unknown>
  swipe: (options: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration: number
  }) => Promise<unknown>
  dragAndDrop: (options: {
    from: { point: string }
    to: { point: string }
    holdDuration: number
    duration: number
  }) => Promise<unknown>
}
interface Daemon {
  info: { runDir: string }
  attach: (options: {
    device: string
    platform: string
    appId: string
    teamId?: string
  }) => Promise<Device>
  close: () => void
}
interface Card {
  name: string
  enabled: boolean
  bounds: Bounds
}

const APP = 'app.teamstation.app'
function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const flatten = (node: Element): Element[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const label = (node: Element): string =>
  node.accessibilityText ?? node.text ?? ''

async function main(): Promise<void> {
  const platform = required('TEST_PLATFORM')
  assert(platform === 'ios' || platform === 'android', 'TEST_PLATFORM')
  const phase = required('TEST_PHASE')
  assert(phase === 'before' || phase === 'after', 'TEST_PHASE')
  const asserting = phase === 'after'
  const device = required('TEST_DEVICE')
  const artifacts = resolve(required('TEST_ARTIFACT_DIR'))
  const only = (process.env.TEST_ONLY ?? 'D1,D4,D6').split(',')
  await mkdir(artifacts, { recursive: true })
  const requireClient = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )
  const { MaestroD } = requireClient('maestro-d') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  // Hierarchy bounds are points on iOS and pixels on Android.
  const scale =
    platform === 'ios'
      ? 1
      : Number(
          /(\d+)\s*$/.exec(
            execFileSync('adb', ['-s', device, 'shell', 'wm', 'density'], {
              encoding: 'utf8'
            })
          )![1]
        ) / 160
  const gap = ROSTER_CARD_GAP * scale
  // iOS rounds accessibility frames outward, so a 48-point card reads as 49
  // and an exact gap as one point short; allow a point either way.
  const tolerance = Math.max(1, scale)
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
    console.log(line)
  }
  const check = (ok: boolean, message: string): void => {
    log(`${ok ? 'ok' : asserting ? 'FAIL' : 'observed'}: ${message}`)
    if (asserting) assert(ok, message)
  }
  try {
    const m = await daemon.attach({
      device,
      platform,
      appId: APP,
      ...(process.env.TEST_TEAM_ID == null
        ? {}
        : { teamId: process.env.TEST_TEAM_ID })
    })
    const all = async (): Promise<Element[]> => flatten(await m.hierarchy())
    const bounds = async (text: string): Promise<Bounds> => {
      const found = (await all()).find(n => label(n) === text)?.bounds
      assert(found != null, `${text} is on screen`)
      return found
    }
    const cards = async (prefix: string, suffix = ''): Promise<Card[]> => {
      const seen = new Map<string, Card>()
      for (const node of await all()) {
        const name = label(node)
        if (
          !name.startsWith(prefix) ||
          !name.endsWith(suffix) ||
          node.bounds == null
        )
          continue
        seen.set(name, {
          name: name.slice(prefix.length),
          enabled: node.enabled !== false,
          bounds: node.bounds
        })
      }
      return [...seen.values()].sort((a, b) => a.bounds.y - b.bounds.y)
    }
    const lineup = async (): Promise<Card[]> => await cards('Reorder ')
    const shot = async (name: string): Promise<void> => {
      const file = `${platform === 'ios' ? '' : 'android-'}${name}-${phase}.png`
      await writeFile(join(artifacts, file), await m.screenshot())
      log(`captured ${file}`)
    }
    const open = async (): Promise<void> => {
      await m.stopApp({ appId: APP })
      await m.openLink({ link: 'teamstation:///games/g1/score' })
      await m.tapOn({ text: 'Open scoring menu', timeout: 30000 })
      await m.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
      await m.assertVisible({ text: 'Batting lineup', timeout: 15000 })
      await pause(800)
    }
    /** Waits until two reads 500 ms apart agree, so a fling has stopped. */
    const settled = async (): Promise<Card[]> => {
      let last = JSON.stringify(await lineup())
      for (let i = 0; i < 10; i++) {
        await pause(500)
        const now = JSON.stringify(await lineup())
        if (now === last) return JSON.parse(now) as Card[]
        last = now
      }
      throw new Error('The lineup never settled')
    }

    // iOS: W3C touch actions through this daemon's own WebDriverAgent.
    // XCTest folds a pause after pointerDown into the next move, so a hold is
    // a two-point creep over a second.
    let wda: { url: string; session: string } | undefined
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const url = wda!.url + path
      const script =
        body == null
          ? `http.get(${JSON.stringify(url)})`
          : `http.post(${JSON.stringify(url)}, {body:${JSON.stringify(body)}})`
      const result = (await m.eval(script)) as { status: number; body: string }
      assert.equal(result.status, 200, result.body)
      return JSON.parse(result.body) as unknown
    }
    if (platform === 'ios') {
      const daemonLog = await readFile(
        join(daemon.info.runDir, 'daemon.log'),
        'utf8'
      )
      const line = daemonLog
        .split('\n')
        .filter(s => s.includes(`Starting WDA on device ${device} (port:`))
        .at(-1)
      const port = line?.match(/\(port: (\d+)\)/)?.[1]
      assert(port != null, 'This daemon started WebDriverAgent')
      wda = { url: `http://127.0.0.1:${port}`, session: '' }
      const status = (await request('/status')) as { sessionId: string }
      wda.session = status.sessionId
    }
    const touch = async (
      points: Array<{ x: number; y: number; ms: number }>
    ): Promise<void> => {
      const move = (p: { x: number; y: number; ms: number }): unknown => ({
        type: 'pointerMove',
        duration: p.ms,
        x: Math.round(p.x),
        y: Math.round(p.y),
        origin: 'viewport'
      })
      await request(`/session/${wda!.session}/actions`, {
        actions: [
          {
            type: 'pointer',
            id: 'finger',
            parameters: { pointerType: 'touch' },
            actions: [
              move({ ...points[0], ms: 0 }),
              { type: 'pointerDown', button: 0 },
              ...points
                .slice(1)
                .flatMap(p => [move(p), { type: 'pause', duration: 150 }]),
              { type: 'pointerUp', button: 0 }
            ]
          }
        ]
      })
    }
    const held = async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      midDrag?: string
    ): Promise<void> => {
      if (platform === 'ios') {
        const gesture = touch([
          { ...from, ms: 0 },
          { x: from.x, y: from.y + 2, ms: 1000 },
          { ...to, ms: 1500 },
          { ...to, ms: 400 }
        ])
        // Held until the screenshot is taken, then rethrown, so a failed
        // gesture is reported rather than left unhandled.
        const failure = gesture.then(
          () => undefined,
          (error: unknown) => error
        )
        try {
          if (midDrag != null && process.env.TEST_SIMULATOR === '1') {
            // The finger reaches the drop point about 2.8 s in, and rests
            // there.
            await pause(3100)
            const file = `${midDrag}-${phase}.png`
            execFileSync('xcrun', [
              'simctl',
              'io',
              device,
              'screenshot',
              join(artifacts, file)
            ])
            log(`captured ${file} mid-drag`)
          }
        } finally {
          const error = await failure
          if (error !== undefined)
            // eslint-disable-next-line no-unsafe-finally
            throw error instanceof Error
              ? error
              : new Error(JSON.stringify(error))
        }
      } else
        await m.dragAndDrop({
          from: { point: `${Math.round(from.x)},${Math.round(from.y)}` },
          to: { point: `${Math.round(to.x)},${Math.round(to.y)}` },
          holdDuration: 1000,
          duration: 1500
        })
      await pause(800)
    }
    const swipe = async (
      x: number,
      from: number,
      to: number
    ): Promise<void> => {
      if (platform === 'ios')
        await touch([
          { x, y: from, ms: 0 },
          { x, y: to, ms: 250 }
        ])
      else
        await m.swipe({
          startX: Math.round(x),
          startY: Math.round(from),
          endX: Math.round(x),
          endY: Math.round(to),
          duration: 250
        })
    }
    const centreX = (b: Bounds): number => b.x + b.width / 2
    const third = (b: Bounds): number => b.y + b.height / 3
    const order = (list: Card[]): string => list.map(c => c.name).join(', ')

    if (only.includes('D1')) {
      log('D1 held lineup drag; the list stays put')
      await open()
      const list = await bounds('Batting lineup')
      await swipe(
        list.x + list.width / 2,
        list.y + list.height - 40 * scale,
        list.y + list.height - 160 * scale
      )
      let start = await settled()
      // Keep at least two cards below the visible end, so an Android
      // overscroll clamp cannot move the list after the drop.
      const last = start.at(-1)!.bounds
      if (
        last.y + last.height - (list.y + list.height) <
        2 * (last.height + gap)
      ) {
        await swipe(
          list.x + list.width / 2,
          list.y + 80 * scale,
          list.y + 140 * scale
        )
        start = await settled()
      }
      const k = start.findIndex(
        c => c.bounds.y + c.bounds.height / 2 > list.y + 48 * scale
      )
      assert(k > 0 && k + 3 < start.length, 'A card below the auto-scroll band')
      await held(
        {
          x: centreX(start[k].bounds),
          y: start[k].bounds.y + start[k].bounds.height / 2
        },
        { x: centreX(start[k + 3].bounds), y: third(start[k + 3].bounds) },
        'lineup-drag'
      )
      const after = await lineup()
      await shot('lineup-drag-dropped')
      const names = start.map(c => c.name)
      const want = [...names]
      want.splice(k + 3, 0, ...want.splice(k, 1))
      const got = after.map(c => c.name)
      log(`D1 order before ${names.join(', ')}`)
      log(`D1 order after ${got.join(', ')}`)
      // Before M2 lands, the dropped card reopens at height 0 and the phone
      // leaves it out of the hierarchy; D2 asserts its height. A failed drop
      // leaves it visible in its old slot. Android lists only the cards on
      // screen, so compare the ones both reads saw.
      const heldName = names[k]
      check(
        want.filter(name => got.includes(name)).join(', ') ===
          got.filter(name => names.includes(name)).join(', ') &&
          (!got.includes(heldName) || got.indexOf(heldName) === k + 3),
        `the held card moved from slot ${k} to slot ${k + 3}`
      )
      for (let i = 0; i < k; i++) {
        const moved = after.find(c => c.name === names[i])
        check(
          moved != null &&
            Math.abs(moved.bounds.y - start[i].bounds.y) <= tolerance,
          `${names[i]} above the held card kept its y (${start[i].bounds.y} → ${moved?.bounds.y})`
        )
      }
    }

    if (only.includes('D4')) {
      log('D4 a quick swipe still scrolls')
      await open()
      const list = await bounds('Batting lineup')
      const start = await lineup()
      await swipe(
        list.x + list.width / 2,
        list.y + list.height - 40 * scale,
        list.y + list.height - 130 * scale
      )
      const after = await settled()
      // A fling can carry the top card off screen; measure one both reads see.
      const seen = after.find(c => start.some(s => s.name === c.name))
      const was = start.find(c => c.name === seen?.name)
      check(
        seen != null &&
          was != null &&
          was.bounds.y - seen.bounds.y > 30 * scale,
        `the lineup scrolled (${seen?.name}: ${was?.bounds.y} → ${seen?.bounds.y})`
      )
      const common = (list: Card[], other: Card[]): string =>
        order(list.filter(c => other.some(o => o.name === c.name)))
      check(
        common(after, start) === common(start, after),
        'the order is unchanged'
      )
    }

    if (only.includes('D6')) {
      log('D6 held defensive drop')
      await open()
      await m.tapOn({ text: 'Set Defense', timeout: 10000 })
      await pause(600)
      await m.tapOn({ text: 'Clear P', timeout: 10000 })
      await pause(600)
      // In defense the roster cards are labelled with the player's name.
      const column = await bounds('Roster players')
      const player = (await all()).find(
        n =>
          n.bounds != null &&
          n.enabled !== false &&
          /^[A-Z][a-z]+ [A-Z]\.$/.test(label(n)) &&
          n.bounds.x < column.x + column.width &&
          n.bounds.height > 40 * scale
      )
      assert(player?.bounds != null, 'An enabled roster player')
      const name = label(player)
      const target = await bounds('Unassigned')
      await held(
        {
          x: centreX(player.bounds),
          y: player.bounds.y + player.bounds.height / 2
        },
        { x: centreX(target), y: target.y + target.height / 2 }
      )
      const clear = (await all()).find(n => label(n) === 'Clear P')
      check(clear != null && clear.enabled !== false, `${name} fills P`)
      await shot('defense-drop')
    }
    log(`PASS phase ${phase} on ${platform}: ${only.join(', ')}`)
  } finally {
    await writeFile(
      join(artifacts, `${platform}-${phase}-steps.txt`),
      lines.join('\n') + '\n'
    )
    daemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
