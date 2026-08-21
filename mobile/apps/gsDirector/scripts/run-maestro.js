#!/usr/bin/env node
// Runs Maestro flows against the connected iPad, or a simulator with --sim.
//
// Defaults to the device: it is the hardware the app has to work on, and a simulator cannot say
// anything about thermals or sustained encode. The simulator is still worth running the camera flows
// on, because it reaches the real cameras through the Mac's own network.
//
//   node scripts/run-maestro.js                      all flows in maestro/flows
//   node scripts/run-maestro.js smoke                one flow by name
//   node scripts/run-maestro.js --sim rtsp-camera-naming   on the booted simulator
//   node scripts/run-maestro.js --suite operator     product-behavior vectors
//   node scripts/run-maestro.js --list

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { resolveDevice } = require('./deviceTarget')

const ROOT = path.resolve(__dirname, '..')
const FLOW_DIR = path.join(ROOT, 'maestro', 'flows')
const REPORT_DIR = path.join(ROOT, 'maestro', 'reports')
const RUNNER = path.join(
  os.homedir(),
  '.maestro-runner',
  'bin',
  'maestro-runner'
)
const TEAM_ID = process.env.DIRECTOR_TEAM_ID ?? 'G5LQ7MERPK'

// Product-behavior set from docs/operator-test-vectors.md. Characterization flows stay out so a
// regression pass finishes in one sitting.
const OPERATOR_SUITE = [
  'smoke',
  'operator-source-cap',
  'operator-audio-mix',
  'operator-program-cut',
  'operator-program-disable',
  'operator-empty-tiles',
  'operator-menu-back',
  'scrub-without-history',
  'scrub-before-first-segment',
  'operator-scrub-cut-return',
  'scrub-and-return',
  'hevc-scrub',
  'scrub-incremental',
  'program-five-sources',
  'recordings-export'
]

function flowFiles(names) {
  const available = fs
    .readdirSync(FLOW_DIR)
    .filter(entry => entry.endsWith('.yaml'))
    .sort()
  if (names.length === 0)
    return available.map(entry => path.join(FLOW_DIR, entry))
  return names.map(name => {
    const file = name.endsWith('.yaml') ? name : `${name}.yaml`
    const full = path.join(FLOW_DIR, file)
    if (!fs.existsSync(full)) {
      throw new Error(
        `no flow '${name}' — available: ${available.map(e => e.replace('.yaml', '')).join(', ')}`
      )
    }
    return full
  })
}

function simulatorUdid() {
  if (process.env.DIRECTOR_SIMULATOR_UDID)
    return process.env.DIRECTOR_SIMULATOR_UDID
  const name = process.env.DIRECTOR_SIMULATOR ?? 'iPad Pro 13-inch (M5)'
  const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available'], {
    encoding: 'utf8'
  })
  // Booted first: the same name exists under several runtimes, and a flow should land on the
  // simulator that is already up rather than booting a second one.
  const matches = raw
    .split('\n')
    .filter(line => line.includes(`${name} (`))
    .sort((a, b) => Number(b.includes('Booted')) - Number(a.includes('Booted')))
  const udid = matches[0]?.match(/\(([0-9A-Fa-f-]{36})\)/)?.[1]
  if (!udid) throw new Error(`no available simulator named '${name}'`)
  return udid
}

function parseFlowNames(args) {
  const names = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--list') continue
    if (value === '--suite') {
      const suite = args[index + 1]
      index += 1
      if (suite !== 'operator') {
        throw new Error(`unknown suite '${suite}' — available: operator`)
      }
      names.push(...OPERATOR_SUITE)
      continue
    }
    if (value.startsWith('--')) continue
    names.push(value)
  }
  return names
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    process.stdout.write('suite operator:\n')
    for (const name of OPERATOR_SUITE) process.stdout.write(`  ${name}\n`)
    process.stdout.write('flows:\n')
    for (const entry of fs
      .readdirSync(FLOW_DIR)
      .filter(e => e.endsWith('.yaml'))
      .sort()) {
      process.stdout.write(`  ${entry.replace('.yaml', '')}\n`)
    }
    return
  }

  if (!fs.existsSync(RUNNER)) {
    throw new Error(
      `maestro-runner not found at ${RUNNER} — install from open.devicelab.dev`
    )
  }

  const useSimulator = args.includes('--sim')
  const flows = flowFiles(parseFlowNames(args))
  const device = useSimulator ? null : resolveDevice()
  const target = useSimulator ? simulatorUdid() : device.udid
  const targetName = useSimulator
    ? `simulator ${target}`
    : `${device.name} — ${device.model}`
  process.stdout.write(`Running ${flows.length} flow(s) on ${targetName}\n`)

  // `clearState` reinstalls the bundle, which the runner can only do if it is handed the built app.
  const appBundle = path.join(
    ROOT,
    'DerivedData',
    'Build',
    'Products',
    useSimulator ? 'Debug-iphonesimulator' : 'Debug-iphoneos',
    'GS Director.app'
  )
  const appArgs = fs.existsSync(appBundle) ? ['--app-file', appBundle] : []
  if (appArgs.length === 0) {
    process.stdout.write(
      `No ${useSimulator ? 'simulator' : 'device'} build found — run scripts/build-${useSimulator ? 'sim' : 'device'}.sh if a flow uses clearState\n`
    )
  }

  const result = spawnSync(
    RUNNER,
    [
      '--platform',
      'ios',
      '--device',
      target,
      // A simulator needs no signing identity, and passing one makes the runner look for a
      // provisioning profile that cannot apply to it.
      ...(useSimulator ? [] : ['--team-id', TEAM_ID]),
      '--driver-start-timeout',
      '180',
      ...appArgs,
      '--artifacts',
      'always',
      '--output',
      REPORT_DIR,
      'test',
      ...flows
    ],
    { stdio: 'inherit' }
  )

  process.exit(result.status ?? 1)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
