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
      field.height,
      base
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
  await visible('Tap or drag a player to where the ball was fielded')
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

async function freshGame() {
  url.searchParams.set('safariAcceptance', String(Date.now()))
  await m.openLink({ link: url.href, browser: true })
  await visible('^Swing in Play$')
  if ((await nodes()).some(n => n.text === 'OK')) await tap('OK')
}
async function tapInSheet(label) {
  // Safari exposes offscreen DOM rows in AX, even under its address toolbar.
  // Scroll inside the actual web viewport before using a row's coordinates.
  for (let attempt = 0; attempt < 10; attempt++) {
    const g = await geometry()
    const node = (await nodes()).find(
      n => n.text === label && n.enabled !== false
    )
    assert(node?.bounds, `Missing sheet row ${label}`)
    const b = node.bounds
    const top = g.field.y + 160
    const bottom = g.field.y + g.field.height - 25
    if (b.y >= top && b.y + b.height / 2 <= bottom) {
      await touch(center(b))
      return
    }
    const lower = bottom - 35
    const upper = top + 40
    await gesture(
      [
        { x: g.field.x + g.field.width / 2, y: b.y < top ? upper : lower },
        { x: g.field.x + g.field.width / 2, y: b.y < top ? lower : upper }
      ],
      80
    )
  }
  assert.fail(`Cannot scroll to sheet row ${label}`)
}

try {
  await m.setOrientation('portrait')
  await freshGame()
  await tap('Swing in Play')
  await absent("^Fielder's Choice$")
  await tap('Home Run')
  let g = await geometry()
  await gesture(
    [
      g.project({ x: 0, z: -18.44 }),
      g.project({ x: 0, z: -100 }, 0.7),
      g.project({ x: 0, z: -129 }, 7)
    ],
    0
  )
  await visible('Drag up and down for ball trajectory')
  const start = {
    x: g.field.x + g.field.width / 2,
    y: g.field.y + g.field.height * 0.25
  }
  // Keep the finger down while reading the live clamped angle, then release.
  await request(`/session/${session}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'scoring-finger',
        parameters: { pointerType: 'touch' },
        actions: [
          {
            type: 'pointerMove',
            duration: 0,
            origin: 'viewport',
            x: Math.round(start.x),
            y: Math.round(start.y)
          },
          { type: 'pointerDown', button: 0 },
          {
            type: 'pointerMove',
            duration: 700,
            origin: 'viewport',
            x: Math.round(start.x),
            y: Math.round(g.field.y + g.field.height * 0.75)
          }
        ]
      }
    ]
  })
  await visible('10° Line Drive')
  await shot('stands-line-drive-minimum')
  await touch({ x: start.x, y: g.field.y + g.field.height * 0.75 })
  await m.assertVisible({ text: 'Batter Player 2', timeout: 45000 })
  await freshGame()
  await tap('Open scoring menu')
  await tap('Overrides')
  for (const [base, name] of [
    ['First base', 'Player 6'],
    ['Second base', 'Player 7'],
    ['Third base', 'Player 8']
  ]) {
    await tapInSheet(base)
    await tapInSheet(`Choose ${base} ${name}`)
  }
  await tapInSheet('Apply Override')
  await tap('Swing in Play')
  await visible("^Fielder's Choice$")
  await tap('Error')
  await fieldAndTrajectory()
  await visible('Tap and drag another defender')
  await absent('Home plate decision')
  g = await geometry()
  await gesture([g.project({ x: 24, z: -23 }), g.project({ x: 28, z: -24 })], 0)
  await visible('Tap and drag another defender')
  await tap('Finish defensive play')
  await visible('Who committed the error')
  await shot('error-involved-jerseys')
  await tap('Cancel')
  await tap('Finish defensive play')
  const credit = (await nodes())
    .filter(n => /^Error by /.test(n.text ?? ''))
    .at(-1)
  assert(credit?.text)
  await tap(credit.text)
  await visible('Home plate decision for Player 8')
  await shot('home-decision-right')
  await touch(center(await find(/^Undo /)))
  await visible('Who committed the error')
  await tap(credit.text)
  await tap('Safe')
  await visible('^Finish at-bat$')
  await tap('Finish at-bat')
  await visible('Batter Player 2')
  await shot('error-completed')
  // The remaining runner at second demonstrates a left-stacked third-base target.
  await dragRunner(2, 'out')
  await visible('^Caught Stealing$')
  await cancelRunner()
  await shot('third-base-cancel')
  log(
    'PASS contextual choice, stands clamp, loaded Error relay/credit/Undo, home and third-base touch paths'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
