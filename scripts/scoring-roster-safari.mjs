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

try {
  await m.stopApp()
  await m.launchApp()
  await m.setOrientation('portrait')
  await freshGame()
  await tap('Ball in Play')
  await absent("^Fielder's Choice$")
  await touch({ x: 20, y: 300 })
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
  await shot('roster-initial')
  await tap('Remove Player 2')
  await tap('Add Player 2 to Lineup')
  await shot('tap-appended')
  const swipeTabs = async (a, b) => {
    const from = center(await find(new RegExp('^' + a + '$')))
    const to = center(await find(new RegExp('^' + b + '$')))
    await gesture([from, { x: (from.x + to.x) / 2, y: from.y }, to], 0)
  }
  await swipeTabs('Away Team', 'Home Team')
  await shot('home-slider')
  await swipeTabs('Set Lineup', 'Set Defense')
  await visible('Tap and drag players into their defensive positions.')
  await tap('Clear P')
  const from = center(await find(/^Player 1$/))
  const slot = await find(/^Clear C$/)
  await gesture([from, { x: slot.x - 65, y: slot.y + slot.height / 2 }], 0)
  await shot('defense-replaced')
  await swipeTabs('Home Team', 'Away Team')
  await swipeTabs('Set Defense', 'Set Lineup')
  await visible('Tap players to add them to the lineup')
  const source = center(await find(/^Drag Jordan K\.$/))
  const target = center(await find(/^Drag Player 3$/))
  await gesture([source, target], 0)
  await shot('immediate-lineup-reorder')
  await tap('Cancel')
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
  await visible('^Reorder Jordan K\\.$')
  await shot('cancel-restores-roster')
  await tap('Cancel')
  await m.setOrientation('landscape')
  await touch(center(await find(/^Open scoring menu$/)))
  await touch(center(await find(/^Set Team Rosters$/)))
  await shot('roster-landscape')
  await touch(center(await find(/^Cancel$/)))
  await m.setOrientation('portrait')
  log(
    'PASS roster immediate drag, append, defense replacement, slider swipes and cancel in Safari'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
