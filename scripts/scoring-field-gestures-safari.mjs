// Actual iPhone Safari acceptance. Start an owned maestro-d daemon and fixture
// preview first. Required: SCORING_DEVICE_UDID, MAESTRO_D, SCORING_TEST_URL,
// SCORING_ARTIFACT_DIR. Optional MAESTRO_D_CLIENT_ROOT resolves a packed client
// installed separately from the application. No simulator is booted or stopped.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const client = process.env.MAESTRO_D_CLIENT_ROOT
  ? createRequire(
      join(resolve(process.env.MAESTRO_D_CLIENT_ROOT), 'package.json')
    )
  : require
const { MaestroD } = client('maestro-d')
require('sucrase/register')
const { PerspectiveCamera, Vector3 } = require('three')
const { applyFieldCamera } = require('../src2/app/field/cameraModel')
const required = key => {
  assert(process.env[key], `${key} is required`)
  return process.env[key]
}
const device = required('SCORING_DEVICE_UDID')
const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
const url = new URL(required('SCORING_TEST_URL'))
const daemon = await MaestroD.connect({
  name: required('MAESTRO_D'),
  spawn: false
})
const m = await daemon.attach({
  device,
  platform: 'ios',
  appId: 'com.apple.mobilesafari',
  artifacts: 'on-failure'
})
await mkdir(artifacts, { recursive: true })
let serial = 0
const report = []
const log = message => {
  report.push(message)
  console.log(message)
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)]
const nodes = async () => flatten(await m.hierarchy())
const find = async pattern => {
  const node = (await nodes()).find(
    n => pattern.test(n.text ?? '') && n.enabled !== false
  )
  assert(node?.bounds, `Missing visible control ${pattern}`)
  return node.bounds
}
const tap = text =>
  m.tapOn({ text: `^${text}$`, enabled: true, timeout: 10000 })
const visible = text => m.assertVisible({ text, enabled: true, timeout: 15000 })
const absent = text => m.assertNotVisible({ text })
const shot = async label => {
  const stem = join(artifacts, `${String(++serial).padStart(2, '0')}-${label}`)
  await writeFile(`${stem}.png`, await m.screenshot())
  await writeFile(`${stem}.json`, JSON.stringify(await m.hierarchy(), null, 2))
  log(`Captured ${label}`)
}

// The current iOS driver caches portrait dimensions. W3C viewport coordinates
// also support one uninterrupted path reversing across the halfway threshold.
// Send through maestro-d's documented JS HTTP engine to its own device's WDA.
const driverLog = await readFile(join(daemon.info.runDir, 'daemon.log'), 'utf8')
const line = driverLog
  .split('\n')
  .filter(s => s.includes(`Starting WDA on device ${device} (port:`))
  .at(-1)
assert(line, 'Cannot identify this device WDA endpoint in the owned daemon log')
const port = line.match(/\(port: (\d+)\)/)?.[1]
assert(port, 'Missing WDA port')
const wda = `http://127.0.0.1:${port}`
async function request(path, body) {
  const script =
    body == null
      ? `http.get(${JSON.stringify(wda + path)})`
      : `http.post(${JSON.stringify(wda + path)}, {body:${JSON.stringify(body)}})`
  const result = await m.eval(script)
  assert.equal(result.status, 200, result.body)
  const parsed = JSON.parse(result.body)
  assert(!parsed.value?.error, JSON.stringify(parsed))
  return parsed
}
const session = (await request('/status')).sessionId
assert(session, 'WDA session is required')
async function gesture(points, hold = 500) {
  const size = (await request(`/session/${session}/window/size`)).value
  const move = (p, duration) => {
    assert(
      p.x >= 0 && p.x < size.width && p.y >= 0 && p.y < size.height,
      JSON.stringify({ p, size })
    )
    return {
      type: 'pointerMove',
      duration,
      x: Math.round(p.x),
      y: Math.round(p.y),
      origin: 'viewport'
    }
  }
  await request(`/session/${session}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'scoring-finger',
        parameters: { pointerType: 'touch' },
        actions: [
          move(points[0], 0),
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: hold },
          ...points
            .slice(1)
            .flatMap(p => [
              move(p, p.duration ?? 850),
              { type: 'pause', duration: p.pause ?? 150 }
            ]),
          { type: 'pointerUp', button: 0 }
        ]
      }
    ]
  })
}
async function freshGame() {
  await m.stopApp()
  await m.launchApp()
  url.searchParams.set('safariAcceptance', String(Date.now()))
  await m.openLink({ link: url.href, browser: true })
  await visible('^Ball in Play$')
  if ((await nodes()).some(n => n.text === 'OK')) await tap('OK')
}

async function geometry() {
  const field = await find(/^Baseball field\./)
  const camera = new PerspectiveCamera()
  applyFieldCamera(camera, {
    ...field,
    view: 'home',
    zoom: 1.25,
    tilt: (-11 * Math.PI) / 180,
    heightOffset: 33,
    bottomExtension: 112
  })
  return {
    field,
    project: (x, z, y = 0.7) => {
      const p = new Vector3(x, y, z).project(camera)
      return {
        x: field.x + ((p.x + 1) * field.width) / 2,
        y: field.y + ((1 - p.y) * field.height) / 2
      }
    }
  }
}
try {
  await m.launchApp()
  await m.setOrientation('portrait')
  for (const outside of process.env.SCORING_FIELD_PHASE === 'relay'
    ? []
    : [false, true]) {
    await freshGame()
    await tap('Ball in Play')
    await tap('Home Run')
    await visible('Home run type: In-the-park Home Run')
    const g = await geometry()
    const start = {
      x: g.field.x + g.field.width * 0.25,
      y: g.field.y + g.field.height * 0.64
    }
    const initial = g.project(0, -60)
    const target = g.project(0, outside ? -133 : -95, outside ? 8 : 0.7)
    await gesture(
      [
        start,
        { x: start.x + target.x - initial.x, y: start.y + target.y - initial.y }
      ],
      80
    )
    await visible('Drag up and down for ball trajectory')
    await visible(
      outside
        ? 'Home run type: Home Run'
        : 'Home run type: In-the-park Home Run'
    )
    await shot(outside ? 'stands-trajectory-chip' : 'in-park-trajectory-chip')
    await gesture([start, { x: start.x, y: start.y - 30 }], 80)
    await visible('Batter Player 2')
    await absent('^Safe$')
    await absent('Time to edit play')
    await shot(outside ? 'stands-finished' : 'in-park-finished')
  }
  await freshGame()
  await tap('Ball in Play')
  await tap('Batter Out')
  await tap('Batter Interference')
  await visible('Tap or drag a player to where the ball was fielded')
  const relay = await geometry()
  await gesture([relay.project(0, -18.44, 6)], 80)
  await visible('Drag up and down for ball trajectory')
  const arcStart = {
    x: relay.field.x + relay.field.width * 0.25,
    y: relay.field.y + relay.field.height * 0.6
  }
  await gesture([arcStart, { x: arcStart.x, y: arcStart.y - 25 }], 80)
  await visible('Tap or drag the next defender')
  for (const [x, z, name] of [
    [24, -23, 'Player 3'],
    [15, -41, 'Player 4']
  ]) {
    await gesture([relay.project(x, z, 6)], 80)
    await visible(`Undo Throw to ${name}`)
    await visible('Tap or drag the next defender')
  }
  await gesture([relay.project(-15, -41, 6), relay.project(-10, -35, 6)], 80)
  await visible('Undo Throw to Player 5')
  await visible('Tap or drag the next defender')
  await shot('three-recipient-relay')
  await tap('Finish defensive play')
  await visible('Batter Player 2')
  await visible('1 outs')
  await shot('interference-one-out')
  log(
    process.env.SCORING_FIELD_PHASE === 'relay'
      ? 'PASS Safari interference submenu and tapped/dragged relays'
      : 'PASS Safari relative home-run dragging, status chips, automatic scoring, interference submenu and tapped/dragged relays'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
