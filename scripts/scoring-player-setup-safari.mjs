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
async function freshGame() {
  url.searchParams.set('safariAcceptance', String(Date.now()))
  await m.openLink({ link: url.href, browser: true })
  await visible('^Ball in Play$')
  if ((await nodes()).some(n => n.text === 'OK')) await tap('OK')
}

async function field(label) {
  const node = (await nodes()).find(
    n => n.type === 'TextField' && n.text === label
  )
  assert(node?.bounds, `Missing input ${label}`)
  await touch(center(node.bounds))
}

try {
  await m.stopApp()
  await m.launchApp()
  await m.setOrientation('portrait')
  await freshGame()
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
  await m.scrollUntilVisible({
    element: { text: '^Create Player$' },
    direction: 'DOWN'
  })
  await shot('before-create')
  await touch(center(await find(/^Create Player$/)))
  await visible('^First Name$')
  await shot('player-form-focused')
  await m.inputText('Alex')
  await field('Last Name')
  await m.inputText('Safari')
  await field('Jersey Number')
  await m.inputText('07')
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
    element: { text: '^Save and Add Another Player$' },
    direction: 'DOWN'
  })
  await shot('player-form-preferences')
  await tap('Save and Add Another Player')
  await visible('^First Name$')
  await shot('player-form-reset')
  await m.hideKeyboard()
  await tap('Cancel')
  await m.scrollUntilVisible({
    element: { text: '^Add Alex Safari to Lineup$' },
    direction: 'DOWN'
  })
  await visible('^Add Alex Safari to Lineup$')
  await shot('added-player-roster')
  await tap('Cancel')
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
  await absent('^Add Alex Safari to Lineup$')
  await tap('Cancel')
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
  await tap('Add Placeholder Players')
  await visible('^Number of placeholder players$')
  await touch(
    center((await nodes()).filter(n => n.text === 'Cancel').at(-1).bounds)
  )
  await absent('^Add Owls A to Lineup$')
  await tap('Add Placeholder Players')
  await tap('Add')
  await m.scrollUntilVisible({
    element: { text: '^Add Owls A to Lineup$' },
    direction: 'DOWN'
  })
  await visible('^Add Owls A to Lineup$')
  await tap('Add Placeholder Players')
  const wheel = await find(/^Number of placeholder players$/)
  await gesture([
    { x: wheel.x + wheel.width / 2, y: wheel.y + wheel.height - 25 },
    { x: wheel.x + wheel.width / 2, y: wheel.y + 25, duration: 800 }
  ])
  await shot('placeholder-wheel-scrolled')
  await tap('Player count 3')
  await tap('Add')
  await gesture([
    { x: 95, y: 570 },
    { x: 95, y: 380, duration: 700 }
  ])
  await visible('^Add Owls D to Lineup$')
  await shot('placeholder-batch-added')
  await tap('Save Rosters')
  await tap('Undo Set team roster')
  log(
    'PASS Safari player form, placeholder cancel, scrolling, repeat batch, save and undo'
  )
  await m.setOrientation('landscape')
  await touch(center(await find(/^Open scoring menu$/)))
  await touch(center(await find(/^Set Team Rosters$/)))
  await shot('full-screen-landscape')
  await touch(center(await find(/^Cancel$/)))
  await m.setOrientation('portrait')
  log(
    'PASS full-screen roster, focused player form, preferences, repeated entry and Cancel'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
