#!/usr/bin/env node
// Runs Maestro flows against the connected iPhone, or a simulator with --sim.
//
// Defaults to the device, because the camera is the point and a simulator has none. The flows that
// do not touch capture are still worth running on the simulator, where the synthetic source stands
// in for the lens.
//
//   node scripts/run-maestro.js                        all flows in maestro/flows
//   node scripts/run-maestro.js smoke                  one flow by name
//   node scripts/run-maestro.js --sim settings-codec-bitrate
//   node scripts/run-maestro.js --list

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const FLOW_DIR = path.join(ROOT, 'maestro', 'flows')
const REPORT_DIR = path.join(ROOT, 'maestro', 'reports')
const RUNNER = path.join(os.homedir(), '.maestro-runner', 'bin', 'maestro-runner')

const TEAM_ID = process.env.CAMERAMAN_TEAM_ID ?? 'G5LQ7MERPK'
const DEVICE_UDID = process.env.CAMERAMAN_DEVICE_UDID ?? '00008110-0006098A02FA801E'

// Flows that need a real lens. Named so --sim can refuse them with a reason rather than letting
// them fail somewhere confusing.
const DEVICE_ONLY = new Set(['camera-zoom', 'client-connect', 'settings-lenses'])

function availableFlows () {
  return fs
    .readdirSync(FLOW_DIR)
    .filter(entry => entry.endsWith('.yaml'))
    .sort()
    .map(entry => entry.replace('.yaml', ''))
}

function flowFiles (names, useSimulator) {
  const available = availableFlows()
  const chosen = names.length === 0
    ? available.filter(name => !(useSimulator && DEVICE_ONLY.has(name)))
    : names

  return chosen.map(name => {
    const bare = name.replace(/\.yaml$/, '')
    const full = path.join(FLOW_DIR, `${bare}.yaml`)
    if (!fs.existsSync(full)) {
      throw new Error(`no flow '${bare}' — available: ${available.join(', ')}`)
    }
    if (useSimulator && DEVICE_ONLY.has(bare)) {
      throw new Error(`'${bare}' needs the real camera and cannot run on a simulator`)
    }
    return full
  })
}

function simulatorUdid () {
  if (process.env.CAMERAMAN_SIMULATOR_UDID) return process.env.CAMERAMAN_SIMULATOR_UDID
  const name = process.env.CAMERAMAN_SIMULATOR ?? 'iPhone 16 Pro'
  const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available'], { encoding: 'utf8' })
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

function main () {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const name of availableFlows()) {
      process.stdout.write(`  ${name}${DEVICE_ONLY.has(name) ? '  (device only)' : ''}\n`)
    }
    return
  }

  if (!fs.existsSync(RUNNER)) {
    throw new Error(`maestro-runner not found at ${RUNNER} — install from open.devicelab.dev`)
  }

  const useSimulator = args.includes('--sim')
  const names = args.filter(value => !value.startsWith('--'))
  const flows = flowFiles(names, useSimulator)
  const target = useSimulator ? simulatorUdid() : DEVICE_UDID

  process.stdout.write(
    `Running ${flows.length} flow(s) on ${useSimulator ? `simulator ${target}` : `device ${target}`}\n`
  )

  // `clearState` reinstalls the bundle, which the runner can only do if it is handed the built app.
  const appBundle = path.join(
    ROOT,
    'DerivedData',
    'Build',
    'Products',
    useSimulator ? 'Debug-iphonesimulator' : 'Debug-iphoneos',
    'GS Cameraman.app'
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
      '--platform', 'ios',
      '--device', target,
      // A simulator needs no signing identity, and passing one makes the runner look for a
      // provisioning profile that cannot apply to it.
      ...(useSimulator ? [] : ['--team-id', TEAM_ID]),
      '--driver-start-timeout', '180',
      ...appArgs,
      '--artifacts', 'always',
      '--output', REPORT_DIR,
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
