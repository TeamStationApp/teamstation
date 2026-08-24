#!/usr/bin/env node
// Runs Maestro flows against an iPad or simulator. The target UDID is always passed in so the
// same YAML can run on different machines in parallel.
//
//   node scripts/run-maestro.js --device <udid> smoke
//   node scripts/run-maestro.js --sim --device <udid> rtsp-camera-naming
//   node scripts/run-maestro.js --sim --device <udid> --suite operator
//   node scripts/run-maestro.js --list
//
// `--device` / DIRECTOR_SIMULATOR_UDID / DIRECTOR_DEVICE_UDID select the hardware. Flows never
// name a simulator.

const { spawnSync } = require('node:child_process')
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
  'operator-audio-waveform',
  'operator-program-cut',
  'operator-program-disable',
  'operator-empty-tiles',
  'operator-source-layout',
  'operator-menu-back',
  'stream-controls',
  'scrub-without-history',
  'scrub-before-first-segment',
  'operator-scrub-cut-return',
  'scrub-and-return',
  'hevc-scrub',
  'scrub-incremental',
  'program-five-sources',
  'recordings-export',
  'remote-control',
  'operator-background-record'
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

const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{16}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/

function parseArgs(args) {
  const names = []
  let device
  let useSimulator = false
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--list') continue
    if (value === '--sim') {
      useSimulator = true
      continue
    }
    if (value === '--device') {
      const next = args[index + 1]
      if (!next || next.startsWith('--') || !UDID_PATTERN.test(next)) {
        throw new Error('pass --device <udid>')
      }
      device = next
      index += 1
      continue
    }
    if (value === '--suite') {
      const suite = args[index + 1]
      index += 1
      if (suite !== 'operator') {
        throw new Error(`unknown suite '${suite}' — available: operator`)
      }
      names.push(...OPERATOR_SUITE)
      continue
    }
    if (value.startsWith('--')) {
      throw new Error(`unknown flag '${value}'`)
    }
    names.push(value)
  }
  return { names, device, useSimulator }
}

function requireTargetUdid(useSimulator, cliUdid) {
  const udid = useSimulator
    ? (cliUdid ?? process.env.DIRECTOR_SIMULATOR_UDID)
    : (cliUdid ?? process.env.DIRECTOR_DEVICE_UDID)
  const flag = useSimulator ? 'DIRECTOR_SIMULATOR_UDID' : 'DIRECTOR_DEVICE_UDID'
  if (!udid) {
    throw new Error(`pass --device <udid> or set ${flag}`)
  }
  if (useSimulator) process.env.DIRECTOR_SIMULATOR_UDID = udid
  else process.env.DIRECTOR_DEVICE_UDID = udid
  return udid
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

  const parsed = parseArgs(args)
  const useSimulator = parsed.useSimulator
  const flows = flowFiles(parsed.names)
  const target = requireTargetUdid(useSimulator, parsed.device)
  const targetName = useSimulator
    ? `simulator ${target}`
    : (() => {
        const device = resolveDevice()
        return `${device.name} — ${device.model}`
      })()
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

  const runnerArgs = [
    '--platform',
    'ios',
    '--device',
    target,
    // A simulator needs no signing identity, and passing one makes the runner look for a
    // provisioning profile that cannot apply to it.
    ...(useSimulator ? [] : ['--team-id', TEAM_ID]),
    '--driver-start-timeout',
    '180',
    '--shutdown-after=false',
    ...appArgs,
    '--artifacts',
    'always',
    '--output',
    REPORT_DIR
  ]

  let status = 0
  let batch = []
  const flush = () => {
    if (batch.length === 0) return
    const result = spawnSync(RUNNER, [...runnerArgs, 'test', ...batch], {
      stdio: 'inherit'
    })
    status = result.status ?? 1
    batch = []
  }

  for (const flow of flows) {
    if (status !== 0) break
    if (flow.endsWith('operator-background-record.yaml')) {
      flush()
      if (status !== 0) break
      const result = spawnSync(
        process.execPath,
        [
          path.join(ROOT, 'scripts', 'operatorBackgroundRecord.js'),
          '--device',
          target,
          ...(useSimulator ? ['--sim'] : []),
          ...appArgs,
          '--output',
          REPORT_DIR
        ],
        { stdio: 'inherit' }
      )
      status = result.status ?? 1
      continue
    }
    batch.push(flow)
  }
  if (status === 0) flush()

  process.exit(status)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
