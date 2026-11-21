// Fetches what a build of HiGHS and the scheduler engine needs, pinned by
// native/highs/highs-source.json: HiGHS's source, CMake when the build host
// has none on PATH (Mason's NoMac iOS hosts install no Homebrew packages),
// and Emscripten for the web's WebAssembly. Each archive is checked against
// its sha256 before it is unpacked, and is fetched again only when the pin
// changes. HiGHS and CMake go into native/highs/vendor/ (HiGHS/ and cmake/,
// the same paths for every version, so the Xcode and CMake projects name
// them once), which git ignores. Emscripten goes outside the checkout, into
// ~/.cache/teamstation/emscripten-<version>-<host>/ (or TS_EMSCRIPTEN_HOME),
// so every checkout on a host shares one copy and one cache of its system
// libraries.
//
//   node scripts/highsSource.mjs              # prints the source directory
//   node scripts/highsSource.mjs --cmake      # prints the cmake to run
//   node scripts/highsSource.mjs emscripten   # prints Emscripten's directory
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'native', 'highs', 'vendor')
const pins = JSON.parse(
  readFileSync(join(root, 'native', 'highs', 'highs-source.json'), 'utf8')
)

/** The sha256 of bytes, in hex. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Unpacks a pinned archive into `into` once: fetched, checked, extracted,
 * then marked with its sha256 so a later run with the same pin does nothing.
 * A new pin replaces the whole directory, so nothing of the old version is
 * left beside the new one, and the archive is not kept. Refuses an archive
 * whose bytes are not the pinned ones.
 */
export async function unpackPinned(pin, into, fetchBytes = undefined) {
  fetchBytes ??= async url => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  const marker = join(into, '.sha256')
  if (existsSync(marker) && readFileSync(marker, 'utf8') === pin.sha256)
    return into
  const bytes = await fetchBytes(pin.url)
  const actual = sha256(bytes)
  if (actual !== pin.sha256)
    throw new Error(
      `${pin.url} is ${actual}, not the pinned ${pin.sha256}: refusing it`
    )
  // Per process, so two checkouts unpacking at once do not share a tree.
  const unpacking = `${into}.unpacking-${process.pid}`
  const archive = `${unpacking}.archive`
  rmSync(unpacking, { recursive: true, force: true })
  mkdirSync(unpacking, { recursive: true })
  writeFileSync(archive, bytes)
  try {
    // tar reads gzip and xz alike from the archive itself.
    execFileSync('tar', [
      '-xf',
      archive,
      '-C',
      unpacking,
      '--strip-components',
      '1'
    ])
  } finally {
    rmSync(archive, { force: true })
  }
  writeFileSync(join(unpacking, '.sha256'), pin.sha256)
  // Another process may have finished the same pin meanwhile: its tree is
  // the same bytes, so it is kept and this one dropped.
  if (existsSync(marker) && readFileSync(marker, 'utf8') === pin.sha256) {
    rmSync(unpacking, { recursive: true, force: true })
    return into
  }
  rmSync(into, { recursive: true, force: true })
  renameSync(unpacking, into)
  return into
}

/** The pins, for the tests. */
export function pinned() {
  return pins
}

/** This host's name in the Emscripten pin, as `<os>-<arch>`. */
export function emscriptenHost(
  platform = process.platform,
  arch = process.arch
) {
  const os = platform === 'darwin' ? 'mac' : platform
  return `${os}-${arch === 'x64' ? 'x64' : arch}`
}

/** Where this host's pinned Emscripten lives. */
export function emscriptenHome(env = process.env, host = emscriptenHost()) {
  const override = env.TS_EMSCRIPTEN_HOME
  if (override != null && override !== '') return resolve(override)
  return join(
    env.HOME ?? homedir(),
    '.cache',
    'teamstation',
    `emscripten-${pins.emscripten.version}-${host}`
  )
}

/** Emscripten's config for an unpacked release, as Python reads it. */
export function emscriptenConfig(home, node = process.execPath) {
  const quote = path => JSON.stringify(path)
  return [
    `LLVM_ROOT = ${quote(join(home, 'bin'))}`,
    `BINARYEN_ROOT = ${quote(home)}`,
    `NODE_JS = ${quote(node)}`,
    // The release's own cache, which arrives filled with the system
    // libraries; a build that needs a variant it lacks adds it there.
    `CACHE = ${quote(join(home, 'emscripten', 'cache'))}`,
    ''
  ].join('\n')
}

/**
 * This host's pinned Emscripten, fetched once and checked: the release's
 * prebuilt wasm-binaries (Emscripten, LLVM and Binaryen together), with an
 * `.emscripten` config naming them, the Node running this, and the
 * release's cache of system libraries, which a build adds any variant to. A host with no pin is refused;
 * there is no fallback to a system emcc.
 */
export async function emscripten(
  env = process.env,
  host = emscriptenHost(),
  fetchBytes = undefined
) {
  const entry = pins.emscripten.hosts[host]
  if (entry == null)
    throw new Error(
      `No Emscripten is pinned for ${host}: native/highs/highs-source.json pins ${Object.keys(pins.emscripten.hosts).join(', ')}`
    )
  const home = emscriptenHome(env, host)
  mkdirSync(dirname(home), { recursive: true })
  await unpackPinned(entry, home, fetchBytes)
  const config = join(home, '.emscripten')
  const text = emscriptenConfig(home)
  if (!existsSync(config) || readFileSync(config, 'utf8') !== text)
    writeFileSync(config, text)
  return {
    home,
    config,
    emcc: join(home, 'emscripten', 'emcc'),
    emcmake: join(home, 'emscripten', 'emcmake'),
    version: pins.emscripten.version
  }
}

/** HiGHS's source directory, fetched if it is not there yet. */
export async function highsSource() {
  return await unpackPinned(pins.highs, join(vendor, 'HiGHS'))
}

/** This host's name in the CMake pin: `mac` (one universal build), or `<os>-<arch>`. */
export function cmakeHost(platform = process.platform, arch = process.arch) {
  return platform === 'darwin' ? 'mac' : emscriptenHost(platform, arch)
}

/**
 * Where a pinned CMake unpacks, and its `cmake` inside: the Mac's is an app
 * bundle, Linux's a plain prefix.
 */
export function cmakePinned(host = cmakeHost()) {
  const into = join(vendor, host === 'mac' ? 'cmake' : `cmake-${host}`)
  return {
    into,
    bin:
      host === 'mac'
        ? join(into, 'CMake.app', 'Contents', 'bin', 'cmake')
        : join(into, 'bin', 'cmake')
  }
}

/**
 * The cmake to run: the host's, or this host's pinned one fetched once. A
 * host with neither is refused.
 */
export async function cmake(host = cmakeHost(), fetchBytes = undefined) {
  try {
    execFileSync('cmake', ['--version'], { stdio: 'ignore' })
    return 'cmake'
  } catch {
    const entry = pins.cmake.hosts[host]
    if (entry == null)
      throw new Error(
        `No cmake is installed and none is pinned for ${host}: native/highs/highs-source.json pins ${Object.keys(pins.cmake.hosts).join(', ')}`
      )
    const { into, bin } = cmakePinned(host)
    await unpackPinned(entry, into, fetchBytes)
    return bin
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // No top-level await, so tests can require this module.
  ;(process.argv.includes('--cmake')
    ? cmake()
    : process.argv.includes('emscripten')
      ? emscripten().then(found => found.home)
      : highsSource()
  ).then(
    path => {
      process.stdout.write(`${path}\n`)
    },
    error => {
      console.error(error)
      process.exit(1)
    }
  )
}
