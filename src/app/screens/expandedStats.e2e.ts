// Run against a deterministic statistics fixture on an already reserved iPhone.
// Both the native app and Safari use the same TEST_DEVICE and maestro-d daemon.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  text?: string
  type?: string
  bounds?: Bounds
  children?: Node[]
}
interface Device {
  openLink: (args: { link: string }) => Promise<unknown>
  acceptAlert: () => Promise<unknown>
  assertVisible: (args: { text: string; timeout: number }) => Promise<unknown>
  hierarchy: () => Promise<Node>
  screenshot: () => Promise<Buffer>
  eval: (script: string) => Promise<{ status: number; body: string }>
  stopApp: (args: { appId: string }) => Promise<unknown>
  launchApp: (args: { appId: string }) => Promise<unknown>
}
interface Daemon {
  info: { runDir: string }
  attach: (args: {
    device: string
    platform: string
    appId: string
  }) => Promise<Device>
  close: () => void
}
const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const load = createRequire(
  join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
)
const { MaestroD } = load('maestro-d') as {
  MaestroD: {
    connect: (args: { name: string; spawn: boolean }) => Promise<Daemon>
  }
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

async function main(): Promise<void> {
  const device = required('TEST_DEVICE')
  const appId = required('TEST_APP_ID')
  const native = appId !== 'com.apple.mobilesafari'
  const surface = native ? 'native' : 'safari'
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  try {
    const m = await daemon.attach({ device, platform: 'ios', appId })
    if (native) {
      await m.stopApp({ appId })
      await m.launchApp({ appId })
      await m.assertVisible({
        text: '.*Account.*Demo Viewer.*',
        timeout: 60000
      })
    }
    const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
    const driverLog = readFileSync(
      join(daemon.info.runDir, 'daemon.log'),
      'utf8'
    )
    const line = driverLog
      .split('\n')
      .filter(s => s.includes(`Starting WDA on device ${device} (port:`))
      .at(-1)
    const port = line?.match(/\(port: (\d+)\)/)?.[1]
    assert(port != null, 'Owned device WDA port missing')
    const request = async (
      path: string,
      body?: unknown
    ): Promise<{ sessionId?: string; value: Record<string, unknown> }> => {
      const url = `http://127.0.0.1:${port}${path}`
      const result = await m.eval(
        body == null
          ? `http.get(${JSON.stringify(url)})`
          : `http.post(${JSON.stringify(url)}, {body:${JSON.stringify(body)}})`
      )
      assert.equal(result.status, 200)
      const data = JSON.parse(result.body) as {
        sessionId?: string
        value: Record<string, unknown>
      }
      assert(data.value?.error == null, result.body)
      return data
    }
    await nodes()
    const session =
      (await request('/status')).sessionId ??
      (
        await request('/session', {
          capabilities: { alwaysMatch: { bundleId: appId } }
        })
      ).sessionId
    assert(session != null)
    // W3C gestures through the owned daemon also work with WDA versions that
    // have retired the legacy /wda/tap endpoint.
    const gesture = async (
      from: { x: number; y: number },
      to = from
    ): Promise<void> => {
      await request(`/session/${session}/actions`, {
        actions: [
          {
            type: 'pointer',
            id: 'stats-finger',
            parameters: { pointerType: 'touch' },
            actions: [
              {
                type: 'pointerMove',
                duration: 0,
                x: Math.round(from.x),
                y: Math.round(from.y),
                origin: 'viewport'
              },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 100 },
              {
                type: 'pointerMove',
                duration: from.x === to.x && from.y === to.y ? 0 : 450,
                x: Math.round(to.x),
                y: Math.round(to.y),
                origin: 'viewport'
              },
              { type: 'pointerUp', button: 0 }
            ]
          }
        ]
      })
    }
    const size = (await request(`/session/${session}/window/size`)).value
    const width = Number(size.width)
    const height = Number(size.height)
    const onscreen = (n: Node): boolean =>
      n.bounds != null &&
      n.bounds.x >= 0 &&
      (n.type === 'Button' || n.bounds.x + n.bounds.width <= width) &&
      n.bounds.y > 110 &&
      n.bounds.y + n.bounds.height < height - (native ? 100 : 180)
    const find = async (text: string): Promise<Node | undefined> =>
      (await nodes()).find(n => n.text === text && onscreen(n))
    const tap = async (text: string): Promise<void> => {
      const node = await find(text)
      assert(node?.bounds != null, `Visible control ${text}`)
      await gesture({
        x: node.bounds.x + node.bounds.width / 2,
        y: node.bounds.y + node.bounds.height / 2
      })
    }
    const scroll = async (): Promise<void> => {
      await gesture(
        { x: width - 20, y: height - 240 },
        { x: width - 20, y: 200 }
      )
    }
    const reach = async (text: string): Promise<Node> => {
      for (let i = 0; i < 8; i++) {
        const node = await find(text)
        if (node != null) return node
        await scroll()
      }
      throw new Error(`Could not scroll to ${text}`)
    }
    const shot = async (name: string): Promise<void> => {
      writeFileSync(
        join(required('TEST_ARTIFACT_DIR'), `${surface}-${name}.png`),
        await m.screenshot()
      )
      console.log(`${surface}: captured ${name}`)
    }
    const open = async (route: string, text: string): Promise<void> => {
      await m.openLink({
        link: (native ? 'teamstation:/' : required('TEST_URL')) + route
      })
      if (
        native &&
        (await nodes()).some(n => n.type === 'Alert' || n.text === 'Open')
      )
        await m.acceptAlert()
      await m.assertVisible({ text, timeout: 20000 })
    }
    if (process.env.TEST_SECTION !== 'filter') {
      await open('/teams/demo-hawks?tab=stats', 'SEASON PERFORMANCE')
      await shot('team-after')
      await reach('BATTING')
      const player = await find('Player')
      assert(player?.bounds != null)
      const battingY = player.bounds.y + 38
      for (let i = 0; i < 10 && (await find('PIK')) == null; i++)
        await gesture({ x: width - 35, y: battingY }, { x: 30, y: battingY })
      assert((await find('PIK')) != null, 'Last batting column is reachable')
      await shot('batting-detail')
      await reach('PITCHING')
      await reach('Casey M')
      const table = (await nodes())
        .filter(n => n.text === 'Player' && onscreen(n))
        .at(-1)
      assert(table?.bounds != null)
      const pitchingY = table.bounds.y + 38
      const rows = await nodes()
      assert(
        rows.some(n => n.text === '0.0'),
        'Zero-outs pitcher is shown'
      )
      assert(
        !rows.some(
          n =>
            n.text === 'Alex L' &&
            n.bounds != null &&
            n.bounds.y > table.bounds!.y
        ),
        'Hitter-only player is excluded from pitching'
      )
      for (let i = 0; i < 12 && (await find('BAA')) == null; i++)
        await gesture({ x: width - 35, y: pitchingY }, { x: 30, y: pitchingY })
      assert((await find('BAA')) != null, 'Last pitching column is reachable')
      await shot('pitching-detail')
      await open('/players/102?tab=stats', 'Career')
      await shot('player-pitcher-after')
      await reach('Pitching')
      await reach('SV%')
      assert(
        (await nodes()).some(n => n.text === '—'),
        'Official decisions display unavailable'
      )
      await shot('player-decisions')
      await reach('BAA')
      await shot('player-pitching-detail')
      await open('/players/101?tab=stats', 'Career')
      await shot('player-hitter-after')
      await reach('PIK')
      await scroll()
      const hitter = await nodes()
      assert(
        !hitter.some(
          n => n.text === 'Pitching' || (n.text ?? '').includes('never pitched')
        ),
        'No empty pitching card'
      )
      await shot('player-hitter-bottom')
    }
    await open('/players/101?tab=stats', '.*Alex L.*')
    for (let i = 0; i < 8 && (await find('Filter')) == null; i++)
      await gesture(
        { x: width - 20, y: 250 },
        { x: width - 20, y: height - 250 }
      )
    await tap('Filter')
    await m.assertVisible({ text: '2025', timeout: 10000 })
    await tap('2025')
    await tap('Show these')
    await reach('Show every game')
    await tap('Show every game')
    await m.assertVisible({ text: 'Career', timeout: 10000 })
    await reach('Batting')
    console.log(`${surface}: empty-filter recovery passed`)
    await open('/games/demo-game?tab=boxScore', '.*Batting.*')
    await shot('box-score-after')
    for (const [lead, power] of [
      ['Devin L', 'Emery R'],
      ['Alex L', 'Blair R']
    ]) {
      await reach(lead)
      const rows = await nodes()
      const first = rows.find(n => n.text === lead)
      const second = rows.find(n => n.text === power)
      assert(
        first?.bounds != null &&
          second?.bounds != null &&
          first.bounds.y < second.bounds.y,
        `${lead} leads ${power}`
      )
    }
    await tap('Alex L')
    await m.assertVisible({ text: '.*Alex L.*', timeout: 10000 })
    assert(
      (await nodes()).some(n => n.text === 'Filter'),
      'Box-score player link opens player statistics'
    )
    console.log(
      `${surface}: expanded team/player statistics, column scrolling, absent pitching, both batting orders and player link passed`
    )
  } finally {
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
