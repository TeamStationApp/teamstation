// Actual UIKit roster acceptance in the offline native host from the plan.
// Required: SCORING_DEVICE_UDID, MAESTRO_D,
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
const required = key => {
  assert(process.env[key], `${key} is required`)
  return process.env[key]
}
const device = required('SCORING_DEVICE_UDID')
const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
const daemon = await MaestroD.connect({
  name: required('MAESTRO_D'),
  spawn: false
})
const m = await daemon.attach({
  device,
  platform: 'ios',
  appId: 'app.teamstation.app',
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
const center = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const tap = text =>
  m.tapOn({ text: `^${text}$`, enabled: true, timeout: 10000 })
const visible = text => m.assertVisible({ text, enabled: true, timeout: 15000 })
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
try {
  await m.stopApp()
  await m.launchApp()
  await visible('^Set Team Rosters$')
  await tap('Remove Player 2')
  await shot('hold-start')
  const row = async text => {
    const n = (await nodes()).find(n => n.text === text)
    assert(n?.bounds, text)
    return n.bounds
  }
  const sourceLabel = 'Add Player 2 to Lineup'
  let from = center(await row(sourceLabel))
  await gesture([from, { x: from.x, y: from.y - 90, duration: 250 }], 40)
  await shot('quick-scroll')
  const shifted = await row(sourceLabel)
  assert(shifted.y < from.y - 30, 'Quick swipe must scroll enabled roster row')
  const list = await row('Roster players')
  await gesture(
    [
      { x: list.x + 25, y: list.y + 25 },
      { x: list.x + 25, y: list.y + list.height - 20, duration: 300 }
    ],
    40
  )
  from = center(await row(sourceLabel))
  await m.dragAndDrop({
    from: { text: '^Add Player 2 to Lineup$' },
    to: { text: '^Reorder Player 3$' },
    holdDuration: 600,
    duration: 800
  })
  await visible('^Reorder Player 2$')
  await shot('held-drop')
  await tap('Defense')
  await tap('Clear P')
  await m.dragAndDrop({
    from: { text: '^Player 1$' },
    to: { text: '^Unassigned$' },
    holdDuration: 600,
    duration: 800
  })
  const assigned = (await nodes()).find(n => n.text === 'Clear P')
  assert(
    assigned && assigned.enabled !== false,
    'Pitcher must be assigned after held defensive drop'
  )
  await shot('held-defense')
  await tap('Save Rosters')
  await visible('^Open Rosters$')
  log(
    'PASS native quick roster scrolling, held lineup insertion and defensive drop, Save'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
