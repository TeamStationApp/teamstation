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
const touch = point => gesture([point], 80)

const picker = async () => {
  const n = (await nodes()).find(n => n.type === 'PickerWheel')
  assert(n?.bounds, 'Expected UIKit PickerWheel')
  return n
}
async function pick(count) {
  for (let i = 0; i < 32; i++) {
    const p = await picker()
    if (Number(p.text) === count) return
    const b = (await nodes()).find(n => n.type === 'Picker').bounds
    const c = center(b)
    const delta = Number(p.text) < count ? -45 : 45
    await gesture([c, { x: c.x, y: c.y + delta, duration: 700 }], 80)
  }
  assert.fail(`Picker did not reach ${count}`)
}

async function input(label, text) {
  const n = (await nodes()).find(
    n => n.type === 'TextField' && n.text === label
  )
  assert(n?.bounds, `Missing field ${label}`)
  await touch(center(n.bounds))
  await m.inputText(text)
}
async function cancelChild() {
  await touch(
    center((await nodes()).filter(n => n.text === 'Cancel').at(-1).bounds)
  )
}
try {
  await m.stopApp()
  await m.launchApp()
  await m.setOrientation('portrait')
  await visible('^Set Team Rosters$')
  await tap('Create Player')
  await visible('^First Name$')
  assert(
    (await nodes()).some(n => n.type === 'Keyboard'),
    'First Name must autofocus the keyboard'
  )
  await m.inputText('Alex')
  await input('Last Name', 'Native')
  await input('Jersey Number', '07')
  await m.hideKeyboard()
  await tap('Throws L')
  await tap('Bats S')
  await tap('Player position P')
  await m.scrollUntilVisible({
    element: { text: '^Player position DH$' },
    direction: 'DOWN'
  })
  await tap('Player position DH')
  await m.scrollUntilVisible({
    element: { text: '^Add Player$' },
    direction: 'DOWN'
  })
  await shot('native-player-form')
  await tap('Add Player')
  await tap('Add Placeholder Players')
  assert.equal((await picker()).text, '1')
  await pick(16)
  await shot('native-wheel-sixteen')
  await pick(1)
  await shot('native-wheel-one')
  await pick(3)
  await shot('native-wheel-three')
  await tap('Add')
  await tap('Save Rosters')
  await visible('^Open Rosters$')
  const names = (await nodes())
    .find(n => (n.text ?? '').startsWith('Player 1,'))
    .text.split(', ')
  assert.equal(names.length, 13)
  assert.deepEqual(names.slice(-4), [
    'Alex Native',
    'Owls A',
    'Owls B',
    'Owls C'
  ])
  await shot('native-saved-thirteen')
  await tap('Open Rosters')
  await tap('Add Placeholder Players')
  await pick(16)
  await cancelChild()
  await tap('Save Rosters')
  await visible('^Open Rosters$')
  assert.equal(
    (await nodes())
      .find(n => (n.text ?? '').startsWith('Player 1,'))
      .text.split(', ').length,
    13
  )
  await shot('native-cancel-unchanged')
  log(
    'PASS native form focus, preferences, UIKit wheel 1/3/16, batch names, Save and Cancel'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
