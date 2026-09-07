#!/usr/bin/env node
// Launcher for the fake NDI camera farm, so flows and shell scripts drive it the same way they
// drive `fakeRtspCameras.js`. The generator itself is a Swift executable under
// `mobile/tools/gsNdiCameras`; this builds it on demand, keeps one farm at a time, and exposes the
// fault port.
//
//   node scripts/fakeNdiCameras.js --count 4 --fps 30       # publish four cameras
//   node scripts/fakeNdiCameras.js --self-test              # markers, render cost, pacing
//   node scripts/fakeNdiCameras.js --fault cam=1 drop=0.05  # break one camera
//   node scripts/fakeNdiCameras.js --clock                  # what the generator actually sent
//   node scripts/fakeNdiCameras.js --stop
//
// Network-level impairment is a different tool: scripts/ndiImpair.sh works below NDI's own
// retransmission, which sender-side dropping cannot simulate.

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DIRECTOR_ROOT = path.resolve(__dirname, '..')
const TOOL_DIR = path.resolve(DIRECTOR_ROOT, '../../tools/gsNdiCameras')
const BINARY = path.join(TOOL_DIR, '.build/release/gsNdiCameras')
const STATE_PATH = '/tmp/gs-director-ndi-farm.json'
const DEFAULT_CONTROL_PORT = 8770
const LOG_PATH = '/tmp/gs-director-ndi-farm.log'

function usage() {
  return `Usage: node scripts/fakeNdiCameras.js [options]

  --count N          Cameras to publish (default 4)
  --fps N            Frame rate (default 30)
  --width N          Picture width (default 1920)
  --height N         Picture height (default 1080)
  --name-prefix S    Sender name prefix (default "GS NDI")
  --control-port N   Fault port (default ${DEFAULT_CONTROL_PORT})
  --self-test        Run the generator's own checks and exit
  --fault K=V ...    Apply faults to a running farm, e.g. --fault cam=1 drop=0.05
  --clock            Print what the running farm has sent
  --stop             Stop a farm started earlier
  --rebuild          Force a rebuild of the generator
`
}

function parseArgs(argv) {
  const options = {
    count: 4,
    fps: 30,
    width: 1920,
    height: 1080,
    namePrefix: 'GS NDI',
    controlPort: DEFAULT_CONTROL_PORT,
    selfTest: false,
    fault: null,
    clock: false,
    stop: false,
    rebuild: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[(index += 1)]
    switch (arg) {
      case '--help':
      case '-h':
        process.stdout.write(usage())
        process.exit(0)
        break
      case '--count': options.count = Number(next()); break
      case '--fps': options.fps = Number(next()); break
      case '--width': options.width = Number(next()); break
      case '--height': options.height = Number(next()); break
      case '--name-prefix': options.namePrefix = next(); break
      case '--control-port': options.controlPort = Number(next()); break
      case '--self-test': options.selfTest = true; break
      case '--clock': options.clock = true; break
      case '--stop': options.stop = true; break
      case '--rebuild': options.rebuild = true; break
      case '--fault':
        options.fault = argv.slice(index + 1).filter((value) => value.includes('='))
        index = argv.length
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function ensureBuilt(force) {
  if (!force && fs.existsSync(BINARY)) return
  // The macOS NDI library has to be staged before the package will link.
  if (!fs.existsSync(path.join(TOOL_DIR, 'Vendor/libndi.dylib'))) {
    const staged = spawnSync('bash', [path.join(DIRECTOR_ROOT, 'scripts/bootstrapNdiTools.sh')], {
      stdio: 'inherit'
    })
    if (staged.status !== 0) throw new Error('bootstrapNdiTools.sh failed')
  }
  const built = spawnSync('swift', ['build', '-c', 'release'], { cwd: TOOL_DIR, stdio: 'inherit' })
  if (built.status !== 0) throw new Error('swift build failed')
}

async function request(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`)
  return response.json()
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

async function waitForPort(port, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try {
      await request(port, '/clock')
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return false
}

function stopFarm() {
  const state = readState()
  if (!state) {
    process.stdout.write('no farm recorded\n')
    return
  }
  try {
    // SIGTERM rather than SIGKILL: the senders have to be destroyed for the sources to leave
    // discovery promptly, and a killed process leaves them advertised until they time out — which
    // looks exactly like the reconnect bug the tests are trying to find.
    process.kill(state.pid, 'SIGTERM')
    process.stdout.write(`stopped farm pid ${state.pid}\n`)
  } catch {
    process.stdout.write('farm was not running\n')
  }
  fs.rmSync(STATE_PATH, { force: true })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.stop) return stopFarm()

  if (options.clock || options.fault) {
    const state = readState()
    const port = state?.controlPort ?? options.controlPort
    const route = options.fault ? `/fault?${options.fault.join('&')}` : '/clock'
    process.stdout.write(`${JSON.stringify(await request(port, route), null, 2)}\n`)
    return
  }

  ensureBuilt(options.rebuild)

  if (options.selfTest) {
    const result = spawnSync(BINARY, ['--self-test', '--fps', String(options.fps)], {
      stdio: 'inherit'
    })
    process.exit(result.status ?? 1)
  }

  stopFarm()

  const args = [
    '--count', String(options.count),
    '--fps', String(options.fps),
    '--width', String(options.width),
    '--height', String(options.height),
    '--name-prefix', options.namePrefix,
    '--control-port', String(options.controlPort)
  ]
  // The child's output goes to a file rather than being inherited: inheriting keeps this process's
  // stdout pipe open, so a caller waiting on this command never sees it return.
  const log = fs.openSync(LOG_PATH, 'a')
  const child = spawn(BINARY, args, { detached: true, stdio: ['ignore', log, log] })
  child.unref()
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ pid: child.pid, controlPort: options.controlPort, ...options }, null, 2)
  )
  // Waiting for the port matters: the previous farm's socket can still be in TIME_WAIT when this
  // one binds, and returning before the port answers makes the next command in a script fail with
  // a connection refused that looks like the app's fault.
  if (!(await waitForPort(options.controlPort, 15))) {
    process.stderr.write(`farm started but port ${options.controlPort} never answered\n`)
    process.exit(1)
  }
  process.stdout.write(
    `farm pid ${child.pid}, faults on http://127.0.0.1:${options.controlPort}, log ${LOG_PATH}\n`
  )
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
