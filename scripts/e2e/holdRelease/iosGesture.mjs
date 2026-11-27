#!/usr/bin/env node
// Opt-in fallback for a local hub that cannot deliver two consecutive iOS
// contacts without settling. Reuse its leased WebDriverAgent session only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

const { device, duration, hold, tap } = JSON.parse(readFileSync(0, 'utf8'))
assert.equal(device, process.env.TS_HOLD_IOS_DEVICE, 'select the leased iPhone')
assert.ok(duration === 5000 || duration === 30000, 'unexpected hold duration')
const hub = process.env.MAESTRO_D_BIN ?? 'maestro-d'
const inventory = JSON.parse(
  execFileSync(hub, ['device', 'list', '--json'], { encoding: 'utf8' })
)
const host = name => name.toLowerCase().split('.')[0]
const local = inventory.devices.filter(
  d => d.platform === 'ios' && host(d.machine) === host(hostname())
)
const selected = local.find(d => d.id === device)
assert.ok(selected != null, 'the selected iPhone must belong to the local hub')
// The local hub driver forwards this USB device at its PortFromUDID port.
const portFor = id => {
  const suffix = id.split('-').at(-1).slice(-12)
  assert.match(suffix, /^[\da-f]+$/i, 'unrecognized device identifier')
  return 8100 + (Number.parseInt(suffix, 16) % 1000)
}
const port = portFor(selected.localId)
assert.equal(
  local.filter(d => portFor(d.localId) === port).length,
  1,
  'ambiguous local device port'
)
execFileSync(hub, ['get', 'hierarchy', '--device', device], {
  stdio: 'ignore',
  timeout: 15000
})

const call = async (route, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body == null ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(duration + 10000)
  })
  const result = await response.json()
  assert.ok(
    response.ok && !result.value?.error,
    'WebDriverAgent rejected the request'
  )
  return result
}
const { sessionId } = await call('/status')
assert.ok(
  typeof sessionId === 'string' && sessionId !== '',
  'no existing hub session'
)
const move = ({ x, y }, ms) => {
  assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)
  return { type: 'pointerMove', origin: 'viewport', duration: ms, x, y }
}
const down = { type: 'pointerDown', button: 0 }
const up = { type: 'pointerUp', button: 0 }
const pause = ms => ({ type: 'pause', duration: ms })
const finger = (id, actions) => ({
  type: 'pointer',
  id,
  parameters: { pointerType: 'touch' },
  actions
})
const actions = [finger('hold', [move(hold, 0), down, pause(duration), up])]
if (tap != null) {
  // Each finger starts with its own move. WDA schedules both timelines in a
  // single request. The test checks the actual contact gap on the display.
  actions.push(finger('tap', [move(tap, duration + 80), down, pause(55), up]))
}
await call(`/session/${encodeURIComponent(sessionId)}/actions`, { actions })
