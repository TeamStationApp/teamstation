// Builds the Auto-Scheduler's C++ engine (native/scheduler) against the
// pinned HiGHS source (native/highs/highs-source.json), with CMake.
//
//   node scripts/schedulerBuild.mjs node       # src/common/scheduler/node/scheduler.node
//   node scripts/schedulerBuild.mjs test       # the doctest cases, built and run
//   node scripts/schedulerBuild.mjs wasm       # native/scheduler/build/wasm/
//                                              # scheduler.wasm and scheduler.js,
//                                              # with Asyncify for the time
//                                              # limit's pause
//   node scripts/schedulerBuild.mjs coverage   # this Mac: line coverage of
//                                              # native/scheduler/*.cpp, 90% or more
//   node scripts/schedulerBuild.mjs node test wasm
//
// `node` is the Node-API addon the tests and scripts load
// (src/common/scheduler/engine.ts), compiled against the pinned
// node-addon-api and node-api-headers rather than the installed Node's
// headers. `wasm` is the module every browser downloads, with its glue,
// built by the Emscripten native/highs/highs-source.json pins for this host
// (scripts/highsSource.mjs emscripten) and python3 3.8 or later; it has no
// debug information, and is refused if a build-host path is still inside
// it, as the chat crypto module is. src/build.mjs copies it beside the
// bundle as scheduler-<hash>.wasm. `coverage` builds the doctest runner and the addon with
// -fprofile-instr-generate -fcoverage-mapping, runs doctest and the engine's
// mocha suites through that addon, merges with `xcrun llvm-profdata` and
// reports with `xcrun llvm-cov`.
//
// HiGHS is built once per checkout into native/highs/vendor/build-scheduler
// (position-independent, so it links into the addon) and, for the web,
// native/highs/vendor/build-wasm, and the engine into
// native/scheduler/build/<variant>; both are ignored by git and rebuilt only
// as their sources change.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { homePathIn } from './chatCryptoBuild.mjs'
import { cmake, emscripten, highsSource } from './highsSource.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(root, 'native', 'scheduler')
const highsBuild = join(root, 'native', 'highs', 'vendor', 'build-scheduler')
const highsWasmBuild = join(root, 'native', 'highs', 'vendor', 'build-wasm')
const addonOut = join(root, 'src', 'common', 'scheduler', 'node')
const jobs = String(Math.max(1, availableParallelism()))

/** The engine's mocha suites that the coverage run loads the addon through. */
export const COVERAGE_SUITES = ['src/common/scheduler/engine.test.ts']
/** The least line coverage `coverage` accepts, in percent. */
export const MINIMUM = 90

function run(command, args, options = {}) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
  return result
}

/** HiGHS's static libraries for this host, built once. */
async function buildHighs(cmakeBin) {
  const source = await highsSource()
  if (!existsSync(join(highsBuild, 'lib', 'libhighs.a'))) {
    mkdirSync(highsBuild, { recursive: true })
    run(cmakeBin, [
      '-S',
      source,
      '-B',
      highsBuild,
      '-DBUILD_SHARED_LIBS=OFF',
      '-DBUILD_SHARED_EXTRAS_LIB=OFF',
      '-DFAST_BUILD=ON',
      '-DZLIB=OFF',
      '-DBUILD_TESTING=OFF',
      '-DBUILD_EXAMPLES=OFF',
      '-DBUILD_CXX_EXE=OFF',
      '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
      '-DCMAKE_BUILD_TYPE=Release'
    ])
    run(cmakeBin, ['--build', highsBuild, '-j', jobs])
  }
  return source
}

/** The engine's build directory for a variant, configured and built. */
async function buildEngine(variant, targets) {
  const cmakeBin = await cmake()
  const source = await buildHighs(cmakeBin)
  const build = join(engine, 'build', variant)
  const coverage = variant === 'coverage'
  run(cmakeBin, [
    '-S',
    engine,
    '-B',
    build,
    `-DHIGHS_SOURCE=${source}`,
    `-DHIGHS_BUILD=${highsBuild}`,
    `-DNODE_ADDON_API=${join(root, 'node_modules', 'node-addon-api')}`,
    `-DNODE_API_HEADERS=${join(root, 'node_modules', 'node-api-headers', 'include')}`,
    `-DSCHEDULER_COVERAGE=${coverage ? 'ON' : 'OFF'}`,
    `-DCMAKE_BUILD_TYPE=${coverage ? 'Debug' : 'Release'}`,
    ...(coverage ? ['-DCMAKE_CXX_COMPILER=clang++'] : [])
  ])
  run(cmakeBin, ['--build', build, '-j', jobs, '--target', ...targets])
  return build
}

/** The least Python emcc runs on. */
export const PYTHON_MINIMUM = [3, 8]

/**
 * The python3 on PATH, when it is 3.8 or later: emcc is a Python program, and
 * the Emscripten archive brings none.
 */
export function findPython(env = process.env, probe = spawnSync) {
  const answer = probe(
    'python3',
    [
      '-c',
      'import sys; print(sys.executable); print(sys.version_info[0], sys.version_info[1])'
    ],
    { env, encoding: 'utf8' }
  )
  if (answer.error != null || answer.status !== 0)
    return {
      error: `No python3 on PATH: the web's scheduler build runs emcc, which needs Python ${PYTHON_MINIMUM.join('.')} or later`
    }
  const [executable, version] = String(answer.stdout).trim().split('\n')
  const [major, minor] = version.split(' ').map(Number)
  if (
    major < PYTHON_MINIMUM[0] ||
    (major === PYTHON_MINIMUM[0] && minor < PYTHON_MINIMUM[1])
  )
    return {
      error: `python3 is ${major}.${minor}: the web's scheduler build needs ${PYTHON_MINIMUM.join('.')} or later`
    }
  return { python: executable, version: `${major}.${minor}` }
}

/**
 * The compiler flags of every WebAssembly object: no debug information,
 * WebAssembly's own exceptions, and the build machine's paths mapped away.
 */
export function wasmFlags(env = process.env) {
  return [
    '-O3',
    '-g0',
    '-fwasm-exceptions',
    `-ffile-prefix-map=${root}=.`,
    `-ffile-prefix-map=${env.HOME ?? homedir()}=home`
  ].join(' ')
}

/**
 * Emscripten's glue gives the module a made-up environment whose HOME is
 * `/home/web_user`: a fixed string of the glue, not a path of the build
 * machine, so the check for those leaves it out.
 */
export function withoutVirtualHome(bytes) {
  return Buffer.from(
    Buffer.from(bytes).toString('latin1').replaceAll('"/home/web_user"', '""'),
    'latin1'
  )
}

/**
 * The web's module pauses at its time limit through Asyncify. Only to
 * measure what that costs, `TS_SCHEDULER_ASYNCIFY=0` builds it without (a
 * build at its limit then takes its best schedule), and
 * `TS_SCHEDULER_ASYNCIFY_ADVISE=1` prints what Asyncify instruments.
 */
export function asyncifyOptions(env = process.env) {
  return [
    `-DSCHEDULER_ASYNCIFY=${env.TS_SCHEDULER_ASYNCIFY === '0' ? 'OFF' : 'ON'}`,
    `-DSCHEDULER_ASYNCIFY_ADVISE=${env.TS_SCHEDULER_ASYNCIFY_ADVISE === '1' ? 'ON' : 'OFF'}`
  ]
}

/**
 * The web's module: HiGHS and the engine built with the pinned Emscripten,
 * checked for build-host paths. Returns the module and its glue.
 */
export async function buildWasm(env = process.env) {
  const python = findPython(env)
  if (python.error != null) throw new Error(python.error)
  const em = await emscripten(env)
  const cmakeBin = await cmake()
  const source = await highsSource()
  const emEnv = { ...env, EM_CONFIG: em.config, EMSDK_PYTHON: python.python }
  const flags = wasmFlags(env)
  const configure = (args, cwd) =>
    run(em.emcmake, [cmakeBin, ...args], { env: emEnv, cwd })
  if (!existsSync(join(highsWasmBuild, 'lib', 'libhighs.a'))) {
    mkdirSync(highsWasmBuild, { recursive: true })
    configure([
      '-S',
      source,
      '-B',
      highsWasmBuild,
      '-DBUILD_SHARED_LIBS=OFF',
      '-DBUILD_SHARED_EXTRAS_LIB=OFF',
      '-DFAST_BUILD=ON',
      '-DZLIB=OFF',
      '-DBUILD_TESTING=OFF',
      '-DBUILD_EXAMPLES=OFF',
      '-DBUILD_CXX_EXE=OFF',
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_C_FLAGS=${flags}`,
      `-DCMAKE_CXX_FLAGS=${flags}`
    ])
    run(
      cmakeBin,
      ['--build', highsWasmBuild, '-j', jobs, '--target', 'highs'],
      {
        env: emEnv
      }
    )
  }
  const build = join(engine, 'build', 'wasm')
  configure([
    '-S',
    engine,
    '-B',
    build,
    `-DHIGHS_SOURCE=${source}`,
    `-DHIGHS_BUILD=${highsWasmBuild}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_CXX_FLAGS=${flags}`,
    ...asyncifyOptions(env)
  ])
  run(cmakeBin, ['--build', build, '-j', jobs, '--target', 'scheduler_wasm'], {
    env: emEnv
  })
  const wasm = join(build, 'scheduler.wasm')
  const glue = join(build, 'scheduler.js')
  for (const file of [wasm, glue]) {
    const leaked = homePathIn(
      withoutVirtualHome(readFileSync(file)),
      env.HOME ?? homedir()
    )
    if (leaked != null)
      throw new Error(
        `${file.slice(root.length + 1)} holds a build-host path (${leaked}): not used`
      )
  }
  return { wasm, glue, emscripten: em.version }
}

export async function buildNode() {
  const build = await buildEngine('release', ['scheduler_node'])
  mkdirSync(addonOut, { recursive: true })
  const target = join(addonOut, 'scheduler.node')
  // A new file, not the old one overwritten: macOS kills a process that
  // loads a library written over one whose signature it has already seen.
  rmSync(target, { force: true })
  copyFileSync(join(build, 'scheduler.node'), target)
  return target
}

/**
 * The packed league's request (src/test/packedLeagueRun.ts, with its zones'
 * offsets), written into a build directory for the doctest cases that run
 * it, which find it through SCHEDULER_PACKED_REQUEST.
 */
export function packedRequest(build) {
  const require = createRequire(import.meta.url)
  require('sucrase/register')
  const { wireRequest } = require(
    join(root, 'src', 'common', 'scheduler', 'wire.ts')
  )
  const { packedLeagueRun } = require(
    join(root, 'src', 'test', 'packedLeagueRun.ts')
  )
  const file = join(build, 'packedLeague.request.json')
  writeFileSync(file, JSON.stringify(wireRequest({ input: packedLeagueRun() })))
  return file
}

export async function runTests() {
  const build = await buildEngine('release', ['scheduler_tests'])
  run(join(build, 'scheduler_tests'), [], {
    cwd: root,
    env: { ...process.env, SCHEDULER_PACKED_REQUEST: packedRequest(build) }
  })
  return join(build, 'scheduler_tests')
}

/** The engine's own sources, which the coverage counts. */
export function engineSources() {
  return readdirSync(engine)
    .filter(name => name.endsWith('.cpp'))
    .sort()
    .map(name => join(engine, name))
}

export async function runCoverage() {
  if (process.platform !== 'darwin')
    throw new Error('scheduler coverage runs on a Mac (xcrun llvm-cov)')
  const build = await buildEngine('coverage', [
    'scheduler_tests',
    'scheduler_node'
  ])
  const profiles = join(build, 'profiles')
  rmSync(profiles, { recursive: true, force: true })
  mkdirSync(profiles, { recursive: true })
  const tests = join(build, 'scheduler_tests')
  const addon = join(build, 'scheduler.node')
  run(tests, [], {
    cwd: root,
    env: {
      ...process.env,
      SCHEDULER_PACKED_REQUEST: packedRequest(build),
      LLVM_PROFILE_FILE: join(profiles, 'doctest-%p.profraw')
    }
  })
  run(
    process.execPath,
    [
      join(root, 'node_modules', 'mocha', 'bin', 'mocha.js'),
      '-r',
      'sucrase/register',
      '--timeout',
      '600000',
      '--exit',
      ...COVERAGE_SUITES
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        TS_SCHEDULER_ADDON: addon,
        LLVM_PROFILE_FILE: join(profiles, 'mocha-%p.profraw')
      }
    }
  )
  const merged = join(build, 'scheduler.profdata')
  const raw = readdirSync(profiles)
    .filter(name => name.endsWith('.profraw'))
    .map(name => join(profiles, name))
  run('xcrun', ['llvm-profdata', 'merge', '-sparse', ...raw, '-o', merged])
  const sources = engineSources()
  const objects = [tests, '-object', addon, '-instr-profile', merged]
  run('xcrun', ['llvm-cov', 'report', ...objects, ...sources])
  const exported = spawnSync(
    'xcrun',
    ['llvm-cov', 'export', '-summary-only', ...objects, ...sources],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  if (exported.status !== 0) throw new Error(exported.stderr)
  const lines = JSON.parse(exported.stdout).data[0].totals.lines
  const percent = lines.percent
  console.log(
    `scheduler C++ line coverage: ${percent.toFixed(2)}% (${lines.covered}/${lines.count} lines of native/scheduler/*.cpp)`
  )
  if (percent < MINIMUM)
    throw new Error(`scheduler C++ line coverage is under ${MINIMUM}%`)
  return percent
}

export async function main(argv = process.argv.slice(2)) {
  const wanted = argv.length === 0 ? ['node'] : argv
  for (const what of wanted)
    if (!['node', 'test', 'wasm', 'coverage'].includes(what)) {
      console.error(
        `usage: schedulerBuild.mjs [node] [test] [wasm] [coverage] (not ${what})`
      )
      return 2
    }
  for (const what of wanted) {
    if (what === 'node') {
      const built = await buildNode()
      console.log(`scheduler node: ${built.slice(root.length + 1)}`)
    } else if (what === 'test') await runTests()
    else if (what === 'wasm') {
      const built = await buildWasm()
      console.log(
        `scheduler wasm: ${built.wasm.slice(root.length + 1)} (Emscripten ${built.emscripten})`
      )
    } else await runCoverage()
  }
  return 0
}

if (
  process.argv[1] != null &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    code => {
      process.exitCode = code
    },
    error => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    }
  )
}
