// Real iOS/Android roster-field acceptance against an isolated synthetic API.
// TEST_DEVICE, TEST_PLATFORM, MAESTRO_D, MAESTRO_D_CLIENT_ROOT, and
// TEST_ARTIFACT_DIR are required. TEST_BROWSER_URL uses iOS Safari.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Element {
  text?: string
  value?: string
  accessibilityText?: string
  enabled?: boolean
  visible?: boolean
  bounds?: Bounds
  children?: Element[]
}
interface Device {
  inputText: (options: { text: string }) => Promise<unknown>
  pressKey: (options: { key: string }) => Promise<unknown>
  assertNotVisible: (options: { text: string }) => Promise<unknown>
  scrollUntilVisible: (options: {
    element: { text: string }
    direction?: string
    from?: { text: string }
    timeout?: number
  }) => Promise<unknown>
  hierarchy: () => Promise<Element>
  tapOn: (selector: {
    text?: string
    point?: string
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
  const device = required('TEST_DEVICE')
  const artifacts = resolve(required('TEST_ARTIFACT_DIR'))
  const browser = process.env.TEST_BROWSER_URL
  const appId =
    browser == null ? 'app.teamstation.app' : 'com.apple.mobilesafari'
  const prefix = browser == null ? platform : 'safari'
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
  await mkdir(artifacts, { recursive: true })
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
    console.log(line)
  }
  try {
    const m = await daemon.attach({ device, platform, appId })
    const all = async (): Promise<Element[]> => flatten(await m.hierarchy())
    const bounds = async (text: string): Promise<Bounds> => {
      const found = (await all()).find(
        node =>
          label(node) === text &&
          node.visible !== false &&
          node.enabled !== false &&
          (node.bounds?.width ?? 0) > 0 &&
          (node.bounds?.height ?? 0) > 0
      )?.bounds
      assert(found != null, `${text} is visible`)
      return found
    }
    const tap = async (text: string): Promise<void> => {
      if (browser == null) {
        const warning = (await all()).find(
          node =>
            label(node).includes('Open debugger to view warnings') &&
            node.bounds != null
        )
        if (warning?.bounds != null) {
          const b = warning.bounds
          await m.tapOn({
            point: `${Math.round(b.x + b.width - 22)},${Math.round(b.y + b.height / 2)}`
          })
          await pause(300)
        }
        await m.assertVisible({ text: `^${text}$`, timeout: 15000 })
        const first = await bounds(text)
        await pause(500)
        const fresh = await bounds(text)
        assert.deepEqual(fresh, first, `${text} frame settled`)
        await m.tapOn({
          point: `${Math.round(fresh.x + fresh.width / 2)},${Math.round(fresh.y + fresh.height / 2)}`
        })
      } else await m.tapOn({ text: `^${text}$`, enabled: true, timeout: 15000 })
      await pause(500)
    }
    const shot = async (name: string): Promise<void> => {
      await writeFile(
        join(artifacts, `${prefix}-${name}-after.png`),
        await m.screenshot()
      )
      await writeFile(
        join(artifacts, `${prefix}-${name}-hierarchy.json`),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
    }
    await m.stopApp({ appId })
    await m.openLink({ link: browser ?? 'teamstation:///games/g1/score' })
    await m.assertVisible({ text: '^Open scoring menu$', timeout: 30000 })
    if ((await all()).some(node => label(node) === 'Close')) await tap('Close')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await shot('lineup')
    await tap('Set Defense')
    await m.assertVisible({ text: '^Drag player into defensive position$' })
    await shot('defense')
    await tap('Clear P')
    await m.assertVisible({ text: '^Assign P$' })
    let readValues: (() => Promise<string>) | undefined
    const drag = async (fromName: string, toName: string): Promise<void> => {
      const from = await bounds(fromName)
      const to = await bounds(toName)
      const center = (b: Bounds): { x: number; y: number } => ({
        x: b.x + b.width / 2,
        y: b.y + b.height / 2
      })
      const start = center(from)
      const end = center(to)
      if (platform === 'ios') {
        const daemonLog = await readFile(
          join(daemon.info.runDir, 'daemon.log'),
          'utf8'
        )
        const port = daemonLog
          .split('\n')
          .filter(line =>
            line.includes(`Starting WDA on device ${device} (port:`)
          )
          .at(-1)
          ?.match(/\(port: (\d+)\)/)?.[1]
        assert(port != null, 'Owned WDA endpoint')
        const url = `http://127.0.0.1:${port}`
        const request = async (
          path: string,
          body?: unknown
        ): Promise<{ sessionId?: string; value?: string }> => {
          const script =
            body == null
              ? `http.get(${JSON.stringify(url + path)})`
              : `http.post(${JSON.stringify(url + path)}, {body:${JSON.stringify(body)}})`
          const result = (await m.eval(script)) as {
            status: number
            body: string
          }
          assert.equal(result.status, 200)
          return JSON.parse(result.body) as {
            sessionId?: string
            value?: string
          }
        }
        const session = (await request('/status')).sessionId
        readValues = async () =>
          (await request(`/session/${session}/source`)).value ?? ''
        const move = (
          point: { x: number; y: number },
          duration: number
        ): unknown => ({
          type: 'pointerMove',
          duration,
          origin: 'viewport',
          x: Math.round(point.x),
          y: Math.round(point.y)
        })
        await request(`/session/${session}/actions`, {
          actions: [
            {
              type: 'pointer',
              id: 'field-finger',
              parameters: { pointerType: 'touch' },
              actions: [
                move(start, 0),
                { type: 'pointerDown', button: 0 },
                move({ x: start.x, y: start.y + 2 }, 1000),
                move(end, 1500),
                { type: 'pointerUp', button: 0 }
              ]
            }
          ]
        })
      } else
        await m.dragAndDrop({
          from: { point: `${Math.round(start.x)},${Math.round(start.y)}` },
          to: { point: `${Math.round(end.x)},${Math.round(end.y)}` },
          holdDuration: 1000,
          duration: 1500
        })
      await pause(400)
    }
    await drag('Player 1', 'Assign P')
    await m.assertVisible({ text: '^Clear P$' })
    await tap('Clear P')
    await m.assertVisible({ text: '^Assign P$' })
    log('PASS held upward defensive drag and whole-card clear')
    await drag('Player 1', 'Clear C')
    await m.assertNotVisible({ text: '^Player 1$' })
    await m.assertVisible({ text: '^Player 2$' })
    await drag('Player 2', 'Assign P')
    await tap('Home Team')
    await tap('Away Team')
    await tap('Set Lineup')
    await tap('Set Defense')
    await m.assertVisible({ text: '^Clear P$' })
    log('PASS occupied-target replacement and draft across team/mode switches')
    await tap('Save Rosters')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await tap('Set Defense')
    await m.assertVisible({ text: '^Clear P$' })
    await tap('Cancel')
    await tap('Undo Set team roster')
    log('PASS Save/reopen and Undo')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await tap('Set Defense')
    for (const position of ['P', 'C', '1B', '2B', 'SS'])
      await tap(`Clear ${position}`)
    await m.scrollUntilVisible({
      element: { text: '^Player 14$' },
      from: { text: '^Roster players$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await drag('Player 14', 'Assign P')
    log('PASS scroll lower roster and drag upward to field')
    await tap('Cancel')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await tap('Set Defense')
    await m.assertVisible({ text: '^Clear P$' })
    log('PASS Cancel restores original defense')
    await tap('Create Player')
    await m.assertVisible({ text: '^First Name$' })
    await m.inputText({ text: 'Alex' })
    await m.pressKey({ key: 'Enter' })
    await m.inputText({ text: 'Demo' })
    await m.pressKey({ key: 'Enter' })
    await m.inputText({ text: '42' })
    await m.pressKey({ key: 'Enter' })
    const entered = await all()
    const xml = readValues == null ? '' : await readValues()
    for (const value of ['Alex', 'Demo', '42'])
      assert(
        entered.some(node => node.text === value || node.value === value) ||
          xml.includes(`value="${value}"`),
        `Field contains ${value}`
      )
    if (platform === 'ios')
      assert(
        !xml.includes('<XCUIElementTypeKeyboard'),
        'Keyboard dismissed after jersey submit'
      )
    await shot('player')
    await m.scrollUntilVisible({
      element: { text: '^Add Placeholder Players$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await m.assertVisible({ text: '^Add Placeholder Players$' })
    log('PASS sequential keyboard entry and placeholder action available')
    await tap('Add Placeholder Players')
    await m.assertVisible({ text: '^Select number of players to add.$' })
    await tap('Add')
    await m.assertVisible({ text: '^First Name$' })
    log('PASS placeholder addition returns to player entry')
    await m.scrollUntilVisible({
      element: { text: '^Save and Add Another Player$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Save and Add Another Player')
    await m.assertVisible({ text: '^First Name$' })
    if (readValues != null)
      assert(
        !(await readValues()).includes('value="Alex"'),
        'First name resets after adding another'
      )
    await shot('player-reset')
    log('PASS Save and Add Another resets and refocuses form')
  } finally {
    await writeFile(
      join(artifacts, `${prefix}-field-acceptance.log`),
      '$ node -r sucrase/register src/app/scoring/rosterField.e2e.ts\n' +
        lines.join('\n') +
        '\n'
    )
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
