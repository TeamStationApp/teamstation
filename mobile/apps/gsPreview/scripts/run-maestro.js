#!/usr/bin/env node
// Runs Maestro flows against the iPhone 13 Pro, or a simulator with --sim.
//
//   node scripts/run-maestro.js                        all flows
//   node scripts/run-maestro.js smoke                  one flow by name
//   node scripts/run-maestro.js --sim smoke
//   node scripts/run-maestro.js --list

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const FLOW_DIR = path.join(ROOT, 'maestro', 'flows')
const REPORT_DIR = path.join(ROOT, 'maestro', 'reports')
const RUNNER = path.join(os.homedir(), '.maestro-runner', 'bin', 'maestro-runner')

const TEAM_ID = process.env.PREVIEW_TEAM_ID ?? 'G5LQ7MERPK'
const DEVICE_UDID = process.env.PREVIEW_DEVICE_UDID ?? '00008110-0006098A02FA801E'

function availableFlows () {
  return fs
    .readdirSync(FLOW_DIR)
    .filter(entry => entry.endsWith('.yaml'))
    .sort()
    .map(entry => entry.replace('.yaml', ''))
}

function flowFiles (names) {
  const available = availableFlows()
  const chosen = names.length === 0 ? available : names
  return chosen.map(name => {
    const bare = name.replace(/\.yaml$/, '')
    const full = path.join(FLOW_DIR, `${bare}.yaml`)
    if (!fs.existsSync(full)) {
      throw new Error(`no flow '${bare}' — available: ${available.join(', ')}`)
    }
    return full
  })
}

function simulatorUdid () {
  if (process.env.PREVIEW_SIMULATOR_UDID) return process.env.PREVIEW_SIMULATOR_UDID
  const name = process.env.PREVIEW_SIMULATOR ?? 'iPhone 17 Pro'
  const { execFileSync } = require('node:child_process')
  const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available'], { encoding: 'utf8' })
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
    for (const name of availableFlows()) process.stdout.write(`  ${name}\n`)
    return
  }

  if (!fs.existsSync(RUNNER)) {
    throw new Error(`maestro-runner not found at ${RUNNER} — install from open.devicelab.dev`)
  }

  const useSimulator = args.includes('--sim')
  const names = args.filter(value => !value.startsWith('--'))
  const flows = flowFiles(names)
  const target = useSimulator ? simulatorUdid() : DEVICE_UDID

  process.stdout.write(
    useSimulator
      ? `Running ${flows.length} flow(s) on simulator ${target}\n`
      : `Running ${flows.length} flow(s) on iPhone 13 Pro ${target}\n`
  )

  const appBundle = path.join(
    ROOT,
    'DerivedData',
    'Build',
    'Products',
    useSimulator ? 'Debug-iphonesimulator' : 'Debug-iphoneos',
    'GS Preview.app'
  )
  const appArgs = fs.existsSync(appBundle) ? ['--app-file', appBundle] : []
  if (appArgs.length === 0) {
    process.stdout.write(
      `No ${useSimulator ? 'simulator' : 'device'} build found — run scripts/build-${useSimulator ? 'sim' : 'device'}.sh if a flow uses clearState\n`
    )
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const output = path.join(REPORT_DIR, stamp)
  fs.mkdirSync(output, { recursive: true })

  const result = spawnSync(
    RUNNER,
    [
      '--platform', 'ios',
      '--device', target,
      '--shutdown-after=false',
      ...(useSimulator ? [] : ['--team-id', TEAM_ID]),
      '--driver-start-timeout', '180',
      ...appArgs,
      '--artifacts', 'always',
      '--output', output,
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
