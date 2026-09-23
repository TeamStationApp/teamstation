// Actual iPhone Safari acceptance. Start an owned maestro-d daemon and fixture
// preview first. Required: SCORING_DEVICE_UDID, MAESTRO_D, SCORING_TEST_URL,
// SCORING_ARTIFACT_DIR. Optional MAESTRO_D_CLIENT_ROOT resolves a packed client
// installed separately from the application. No simulator is booted or stopped.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const client = process.env.MAESTRO_D_CLIENT_ROOT
  ? createRequire(
      join(resolve(process.env.MAESTRO_D_CLIENT_ROOT), 'package.json')
    )
  : require
const { MaestroD } = client('maestro-d')
require('sucrase/register')
const { PerspectiveCamera, Vector3 } = require('three')
const { applyFieldCamera } = require('../src2/app/field/cameraModel.ts')
const { BASES } = require('../src2/app/field/fieldModel.ts')
const { TERRAIN } = require('../src2/app/field/terrain.ts')
const { runnerTargets } = require('../src2/app/scoring/runnerDrag.ts')
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
const center = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
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
const touch = point => gesture([point], 80)
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
  const project = (point, y = 6) => {
    const p = new Vector3(point.x, y, point.z).project(camera)
    return {
      x: field.x + ((p.x + 1) / 2) * field.width,
      y: field.y + ((1 - p.y) / 2) * field.height
    }
  }
  const targets = base => {
    const p = project(BASES[base % 4], 9)
    const result = runnerTargets(
      { x: p.x - field.x, y: p.y - field.y },
      field.width,
      field.height
    )
    return Object.fromEntries(
      Object.entries(result).map(([key, rect]) => [
        key,
        {
          x: field.x + rect.x + rect.width / 2,
          y: field.y + rect.y + rect.height / 2
        }
      ])
    )
  }
  return { field, project, targets }
}
async function dragRunner(base, decision) {
  const g = await geometry()
  await gesture([g.project(BASES[base]), g.targets(base + 1)[decision]])
}
async function cancelRunner() {
  await touch(center(await find(/^Cancel$/)))
  await absent('^(Safe|Out) drag target$')
  await absent('^Runner (advance|out)$')
}
async function fieldAndTrajectory() {
  await visible('Drag fielder to location')
  const g = await geometry()
  await gesture([
    g.project({ x: 0, z: -18.44 }),
    { x: g.field.x + g.field.width / 2, y: g.field.y + g.field.height * 0.61 }
  ])
  await visible('Drag up and down for ball trajectory')
  await shot('trajectory-before-movement')
  await pause(1300)
  await shot('trajectory-still-waiting')
  const start = {
    x: g.field.x + g.field.width / 2,
    y: g.field.y + g.field.height * 0.55
  }
  await gesture([start, { x: start.x, y: start.y + 35 }])
}

try {
  await m.setOrientation('portrait')
  url.searchParams.set('safariAcceptance', String(Date.now()))
  await m.openLink({ link: url.href, browser: true })
  await visible('^Ball in Play$')
  if ((await nodes()).some(n => n.text === 'OK')) await tap('OK')
  await shot('ready-portrait')
  await m.longPressOn({ text: '^Ball in Play$', enabled: true })
  await visible('^Single$')
  await absent('^(Copy|Look Up|Translate|Select All)$')
  await shot('long-touch-menu')
  let g = await geometry()
  await touch({ x: g.field.x + 15, y: g.field.y + g.field.height * 0.45 })
  await absent('^Single$')
  await touch(center(await find(/^More$/)))
  await m.assertVisible({ text: '^Wild Pitch$', timeout: 5000 })
  await shot('more-menu')
  await touch({ x: g.field.x + g.field.width - 15, y: g.field.y + 200 })
  await absent('^Wild Pitch$')

  for (const pitch of [
    'Ball',
    'Called Strike',
    'Swing and Miss',
    'Foul Ball'
  ]) {
    await tap(pitch)
    await visible('^Ball$')
    await shot(pitch.toLowerCase().replaceAll(' ', '-'))
  }
  await visible('Pitches 4')
  // Captured upward drag starts on the decorative chevrons. Relative menu row
  // offset follows the current eight-row reversed drag layout, checked below.
  const button = await find(/^Ball in Play$/)
  await gesture([
    { x: button.x + button.width - 12, y: button.y + button.height / 2 },
    { x: button.x + button.width / 2, y: button.y - 132 }
  ])
  await fieldAndTrajectory()
  await visible('^Finish at-bat$')
  await visible(
    'Drag any other runners to advance them or have them called out'
  )
  await shot('correction-countdown')
  await tap('Finish at-bat')
  await visible('Batter Player 2')
  await absent('^Finish at-bat$')

  await dragRunner(1, 'out')
  await visible('^Caught Stealing$')
  await shot('out-reason-portrait')
  await cancelRunner()
  await dragRunner(1, 'safe')
  await visible('^Steal$')
  await shot('safe-reason-portrait')
  await cancelRunner()

  g = await geometry()
  const along = fraction => {
    const a = BASES[1]
    const b = BASES[2]
    const p = g.project(
      { x: a.x + (b.x - a.x) * fraction, z: a.z + (b.z - a.z) * fraction },
      TERRAIN.players
    )
    return { ...p, y: p.y, pause: 700 }
  }
  await gesture([
    g.project(BASES[1]),
    along(0.35),
    along(0.7),
    along(0.35),
    { x: g.field.x + g.field.width - 8, y: g.field.y + g.field.height * 0.65 }
  ])
  await absent('^(Safe|Out) drag target$')
  await absent('^Runner (advance|out)$')
  await shot('reverse-halfway-cancelled')

  await m.setOrientation('landscape')
  await pause(500)
  await shot('ready-landscape')
  await dragRunner(1, 'out')
  await visible('^Caught Stealing$')
  await shot('out-reason-landscape')
  await cancelRunner()
  await dragRunner(1, 'safe')
  await visible('^Steal$')
  await shot('safe-reason-landscape')
  await cancelRunner()
  await m.setOrientation('portrait')
  await dragRunner(1, 'safe')
  await visible('^Steal$')
  await tap('Steal')
  await visible('^Ball in Play$')
  await shot('steal-accepted')

  await tap('Ball in Play')
  await tap('Batter Out')
  await tap('Throw Out')
  await fieldAndTrajectory()
  await visible('Tap and Drag Defender or Hit Done')
  await shot('receiver-choice')
  g = await geometry()
  const destination = g.project(BASES[1], TERRAIN.players)
  await gesture([
    g.project({ x: 24, z: -23 }),
    { ...destination, y: destination.y }
  ])
  await visible('^Finish at-bat$')
  await shot('throw-out-correction')
  await visible('Batter Player 3')
  await absent('^Finish at-bat$')
  await shot('natural-countdown-next-batter')

  await tap('Open scoring menu')
  await tap('Settings')
  await tap('Toggle scoring sound')
  await shot('sound-toggled')
  await tap('Cancel')
  await tap('Ball')
  await visible('^Ball$')
  await tap('Open scoring menu')
  await tap('Settings')
  await tap('Toggle scoring sound')
  await tap('Cancel')
  await touch(center(await find(/^More$/)))
  await tap('Hit by Pitch')
  await visible('^Finish at-bat$')
  await tap('Finish at-bat')
  await visible('Batter Player 4')
  await shot('more-award-completed')
  await shot('completed')
  log(
    'PASS: Safari interaction sequence. Inspect images/video for visual acceptance; actual listening remains a separate gate.'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
