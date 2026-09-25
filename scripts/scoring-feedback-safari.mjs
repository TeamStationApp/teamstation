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
const { initialHitTarget } = require('../src2/app/field/trajectoryGuide')
const { BASES } = require('../src2/app/field/fieldModel')
const { runnerTargets } = require('../src2/app/scoring/runnerDrag')
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
  await visible('^Swing in Play$')
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
  for (const reason of ['hr', 'field', 'controls', 'bunt'].includes(
    process.env.SCORING_FEEDBACK_PHASE
  )
    ? []
    : ['Wild Pitch', 'Passed Ball']) {
    await freshGame()
    await tap('More')
    await absent('^Wild Pitch$')
    await absent('^Passed Ball$')
    await tap('Put Batter on Base')
    await tap('First')
    await visible('Batter Player 2')
    await visible('^Called Strike$')
    await absent('Confirm Placements')
    await absent('Time to edit play')
    await tap('More')
    await absent('^Put Batter on Base$')
    await tap('Dismiss More')
    await tap('Ball')
    await visible('^Called Strike$')
    const g = await geometry()
    const next = g.project(BASES[2].x, BASES[2].z, 9)
    const rect = runnerTargets(
      { x: next.x - g.field.x, y: next.y - g.field.y },
      g.field.width,
      g.field.height,
      2
    ).safe
    await gesture(
      [
        g.project(BASES[1].x, BASES[1].z, 6),
        g.project(BASES[2].x, BASES[2].z, 6),
        {
          x: g.field.x + rect.x + rect.width / 2,
          y: g.field.y + rect.y + rect.height / 2
        }
      ],
      500
    )
    await visible('Runner advance')
    await tap(reason)
    await visible(`Undo ${reason}`)
    await visible('^Called Strike$')
    await shot(reason.toLowerCase().replaceAll(' ', '-'))
    await tap(`Undo ${reason}`)
    await visible('Batter Player 2')
  }
  for (const outside of ['actions', 'field', 'controls', 'bunt'].includes(
    process.env.SCORING_FEEDBACK_PHASE
  )
    ? []
    : [false, true]) {
    await freshGame()
    await tap('Swing in Play')
    await tap('Home Run')
    await visible('Home run type: In-the-park Home Run')
    const g = await geometry()
    const start = {
      x: g.field.x + g.field.width * 0.25,
      y: g.field.y + g.field.height * 0.64
    }
    const initialTarget = initialHitTarget('R')
    const initial = g.project(initialTarget.x, initialTarget.z)
    const target = g.project(0, outside ? -133 : -95, outside ? 8 : 0.7)
    await gesture(
      [
        start,
        ...(!outside
          ? [10, -10].map(x => {
              const cross = g.project(x, -95, 0.7)
              return {
                x: start.x + cross.x - initial.x,
                y: start.y + cross.y - initial.y,
                pause: 300
              }
            })
          : []),
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
    await visible('HOME RUN')
    await shot(outside ? 'stands-led-celebration' : 'in-park-led-celebration')
    await visible('Batter Player 2')
    await new Promise(resolve => setTimeout(resolve, 6500))
    await absent('HOME RUN')
    await absent('^Safe$')
    await absent('Time to edit play')
    await shot(outside ? 'stands-finished' : 'in-park-finished')
  }
  if (['field', 'bunt'].includes(process.env.SCORING_FEEDBACK_PHASE))
    for (const outcome of process.env.SCORING_FEEDBACK_PHASE === 'bunt'
      ? ['Single', 'Throw Out']
      : ['Single', 'Ball Caught', 'Throw Out']) {
      const caught = outcome === 'Ball Caught'
      await freshGame()
      await tap(
        process.env.SCORING_FEEDBACK_PHASE === 'bunt'
          ? 'Bunt in Play'
          : 'Swing in Play'
      )
      if (process.env.SCORING_FEEDBACK_PHASE === 'bunt')
        await absent('^Home Run$')
      if (outcome !== 'Single') {
        await tap('Batter Out')
        await tap(outcome)
      } else await tap('Single')
      await visible('Tap or drag a player to where the ball was fielded')
      const g = await geometry()
      await gesture([g.project(0, -18.44, 6), g.project(20, -40, 0.7)], 80)
      await visible('Drag up and down for ball trajectory')
      await shot(caught ? 'caught-trajectory' : 'single-trajectory')
      const start = {
        x: g.field.x + g.field.width * 0.25,
        y: g.field.y + g.field.height * 0.6
      }
      await gesture([start, { x: start.x, y: start.y - 25 }], 80)
      if (outcome === 'Throw Out') {
        await visible('Tap or drag the next defender')
        const receiver = g.project(24, -23, 6)
        await m.tapOnPoint({
          x: Math.round(receiver.x),
          y: Math.round(receiver.y)
        })
        await tap('Finish defensive play')
      }
      if (caught || outcome === 'Throw Out') await visible('Batter Player 2')
      else {
        await visible('Finish at-bat')
        await tap('Finish at-bat')
      }
      await visible('Batter Player 2')
      await shot(`${outcome}-finished`)
    }
  if (process.env.SCORING_FEEDBACK_PHASE === 'bunt') {
    await freshGame()
    await tap('More')
    await absent('^Between pitches$')
    await absent("^Didn't see it$")
    await visible('^This pitch$')
    await tap('Dismiss More')
    const more = await find(/^More$/)
    const start = { x: more.x + more.width / 2, y: more.y + more.height / 2 }
    const field = await find(/^Baseball field\./)
    await gesture(
      [
        start,
        { x: start.x, y: start.y - 25 },
        { x: field.x + field.width * 0.9, y: start.y - 160 }
      ],
      80
    )
    await absent('^Hit by Pitch$')
    await tap('More')
    await visible('^Hit by Pitch$')
    await tap('Dismiss More')
    await tap('Bunt in Play')
    await absent('^Home Run$')
    await tap('Single')
    await tap('Undo Bunt: Single')
    await visible('Pitches 0')
    await tap('Swing in Play')
    await visible('^Home Run$')
    await shot('bunt-undo-swing-menu')
    await tap('Dismiss outcomes')
  }
  if (process.env.SCORING_FEEDBACK_PHASE === 'controls') {
    await freshGame()
    await tap('Swing in Play')
    await tap('Single')
    await visible('Tap or drag a player to where the ball was fielded')
    for (const label of [
      'Ball',
      'Called Strike',
      'Swing and Miss',
      'Foul Ball',
      'More',
      'Swing in Play'
    ]) {
      const n = (await nodes()).find(n => n.text === label)
      assert(n?.bounds, `Missing ${label}`)
      await gesture(
        [
          {
            x: n.bounds.x + n.bounds.width / 2,
            y: n.bounds.y + n.bounds.height / 2
          }
        ],
        80
      )
      await absent('^Hit by Pitch$')
      await absent('^Single$')
      await visible('Tap or drag a player to where the ball was fielded')
    }
    await shot('disabled-bottom-controls')
    await tap('Undo Single')
    await tap('More')
    await shot('larger-more-menu')
    await tap('Put Batter on Base')
    await shot('larger-more-submenu')
    await tap('First')
    await visible('Batter Player 2')
    const g = await geometry()
    const from = BASES[1]
    const to = BASES[2]
    const p = t =>
      g.project(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, 0.7)
    await gesture(
      [g.project(from.x, from.z, 6), p(0.25), p(0.75), p(0.25), p(0)],
      500
    )
    await absent('Safe drag target')
    await absent('Runner advance')
    const next = g.project(to.x, to.z, 9)
    const rect = runnerTargets(
      { x: next.x - g.field.x, y: next.y - g.field.y },
      g.field.width,
      g.field.height,
      2
    ).safe
    await gesture(
      [
        g.project(from.x, from.z, 6),
        p(0.75),
        {
          x: g.field.x + rect.x + rect.width / 2,
          y: g.field.y + rect.y + rect.height / 2
        }
      ],
      500
    )
    await visible('Runner advance')
    await shot('runner-safe-reasons')
    await tap('Cancel')
    await absent('Safe drag target')
    await absent('Runner advance')
    await shot('cancelled-runner-return')
  }
  log('PASS Safari selected scoring-feedback scenarios')
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
