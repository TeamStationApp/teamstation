#!/usr/bin/env node
// Orchestrates the background-record proof: HUD while foregrounded, Settings in front,
// control-server keep-alive probe, then return to Director and stop.
//
// Invoked by run-maestro.js instead of handing operator-background-record.yaml to
// maestro-d as a single file, because the keep-alive assert has to run while
// another app is in front.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const RUNNER = path.join(os.homedir(), '.maestro-d', 'bin', 'maestro-d')
/** The team that signs this app: its clientConfig.json's, checked by scripts/clientConfig.mjs; empty when there is none. */
function clientTeam() {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, '..', '..', '..', 'scripts', 'clientConfig.mjs'), ROOT, '--team'],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'clientConfig.mjs --team failed')
  return result.stdout.trim()
}
const TEAM_ID = process.env.DIRECTOR_TEAM_ID || clientTeam()

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function main() {
  const args = process.argv.slice(2)
  const deviceIndex = args.indexOf('--device')
  if (deviceIndex < 0 || !args[deviceIndex + 1]) {
    fail('usage: operatorBackgroundRecord.js --device <udid> [--app-file <app>] [--output <dir>]')
  }
  const udid = args[deviceIndex + 1]
  const appIndex = args.indexOf('--app-file')
  const appFile = appIndex >= 0 ? args[appIndex + 1] : ''
  const outputIndex = args.indexOf('--output')
  const output = outputIndex >= 0 ? args[outputIndex + 1] : path.join(ROOT, 'maestro', 'reports')
  const useSimulator = args.includes('--sim')

  if (!fs.existsSync(RUNNER)) {
    fail(`maestro-d not found at ${RUNNER}`)
  }

  const common = [
    '--platform',
    'ios',
    '--device',
    udid,
    ...(useSimulator ? [] : ['--team-id', TEAM_ID]),
    '--driver-start-timeout',
    '180',
    '--shutdown-after=false',
    ...(appFile ? ['--app-file', appFile] : []),
    '--artifacts',
    'always',
    '--output',
    output,
    'test'
  ]

  run(RUNNER, [
    ...common,
    path.join(ROOT, 'maestro', 'flows', 'operator-background-record.yaml')
  ])
  run(RUNNER, [
    ...common.filter((value, index, list) => !(value === '--app-file' || list[index - 1] === '--app-file')),
    path.join(ROOT, 'maestro', 'flows', 'shared', 'background-open-settings.yaml')
  ])
  run(process.execPath, [path.join(__dirname, 'assertBackgroundKeepAlive.js')])
  run(RUNNER, [
    ...common.filter((value, index, list) => !(value === '--app-file' || list[index - 1] === '--app-file')),
    path.join(ROOT, 'maestro', 'flows', 'shared', 'background-return-and-stop.yaml')
  ])
}

main()
