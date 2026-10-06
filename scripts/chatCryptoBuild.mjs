// Builds the chat crypto core (crates/chat-crypto) for Node and for the
// browser, from source, with the toolchain its rust-toolchain.toml pins.
//
//   node scripts/chatCryptoBuild.mjs node        # src/common/chatCrypto/node/chat_crypto.node
//   node scripts/chatCryptoBuild.mjs wasm        # src/common/chatCrypto/wasm/chat_crypto.wasm
//   node scripts/chatCryptoBuild.mjs node wasm
//
// `node` is the Node-API addon the server, the scripts and the tests load.
// `wasm` is the module every browser downloads, so it is built without
// debug information, with the build machine's paths remapped away, and it is
// refused if any home-directory path is still inside it.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'crates', 'chat-crypto')
const out = join(root, 'src', 'common', 'chatCrypto')

/** The first home-directory path inside `bytes`, or undefined. */
export function homePathIn(bytes, home = homedir()) {
  const text = Buffer.from(bytes).toString('latin1')
  for (const needle of ['/Users/', '/home/', '/root/', home]) {
    if (needle !== '' && needle !== '/' && text.includes(needle)) return needle
  }
  return undefined
}

/** `PATH` with cargo's bin first, and that cargo, or why there is none. */
export function findCargo(env = process.env) {
  const cargoHome = env.CARGO_HOME ?? join(env.HOME ?? homedir(), '.cargo')
  const path = `${join(cargoHome, 'bin')}:${env.PATH ?? ''}`
  // Asked inside the crate, where rust-toolchain.toml names the toolchain:
  // a rustup with no default answers nothing anywhere else.
  const probe = spawnSync('cargo', ['--version'], {
    cwd: crate,
    env: { ...env, PATH: path },
    encoding: 'utf8'
  })
  if (probe.error != null || probe.status !== 0) {
    return {
      error:
        'No cargo: install Rust with rustup (https://rustup.rs); ' +
        'crates/chat-crypto/rust-toolchain.toml brings the rest on first use.'
    }
  }
  return { path, cargoHome }
}

/** Where cargo writes: `CARGO_TARGET_DIR` (from the crate) when set. */
export function targetDir(env = process.env) {
  return env.CARGO_TARGET_DIR != null && env.CARGO_TARGET_DIR !== ''
    ? resolve(crate, env.CARGO_TARGET_DIR)
    : join(crate, 'target')
}

function cargo(args, env) {
  const run = spawnSync('cargo', args, {
    cwd: crate,
    env,
    stdio: 'inherit'
  })
  if (run.status !== 0) {
    throw new Error(`cargo ${args.join(' ')} failed`)
  }
}

export function buildNode(found, env = process.env) {
  // chacha20 0.9 uses its NEON code on arm64 (an Apple-silicon Mac) only
  // when asked; elsewhere the flag does nothing.
  cargo(['build', '--release', '--locked', '--features', 'node', '--lib'], {
    ...env,
    PATH: found.path,
    RUSTFLAGS: '--cfg chacha20_force_neon'
  })
  const name =
    process.platform === 'darwin'
      ? 'libchat_crypto.dylib'
      : process.platform === 'win32'
        ? 'chat_crypto.dll'
        : 'libchat_crypto.so'
  mkdirSync(join(out, 'node'), { recursive: true })
  const target = join(out, 'node', 'chat_crypto.node')
  // A new file, not the old one overwritten: macOS kills a process that
  // loads a library written over one whose signature it has already seen.
  rmSync(target, { force: true })
  copyFileSync(join(targetDir(env), 'release', name), target)
  return target
}

export function buildWasm(found, env = process.env) {
  const rustflags = [
    // rustc takes the last prefix that matches: the home directory first, so
    // cargo's home, usually under it, wins. The crate's own files are named
    // relative to it already, so its path is not remapped: the flags stay the
    // same wherever the crate lies (a deploy's new version directory), and
    // cargo keeps every dependency it built last time.
    `--remap-path-prefix=${env.HOME ?? homedir()}=home`,
    `--remap-path-prefix=${found.cargoHome}=cargo`
  ].join(' ')
  cargo(
    [
      'build',
      '--locked',
      '--profile',
      'wasm',
      '--target',
      'wasm32-unknown-unknown',
      '--lib'
    ],
    { ...env, PATH: found.path, RUSTFLAGS: rustflags }
  )
  const built = join(
    targetDir(env),
    'wasm32-unknown-unknown',
    'wasm',
    'chat_crypto.wasm'
  )
  const leaked = homePathIn(readFileSync(built), env.HOME ?? homedir())
  if (leaked != null) {
    throw new Error(`The WASM module holds a home path (${leaked}): not copied`)
  }
  mkdirSync(join(out, 'wasm'), { recursive: true })
  const target = join(out, 'wasm', 'chat_crypto.wasm')
  copyFileSync(built, target)
  return target
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const wanted = argv.length === 0 ? ['node', 'wasm'] : argv
  for (const what of wanted) {
    if (what !== 'node' && what !== 'wasm') {
      console.error(`usage: chatCryptoBuild.mjs [node] [wasm] (not ${what})`)
      return 2
    }
  }
  const found = findCargo(env)
  if (found.error != null) {
    console.error(found.error)
    return 1
  }
  for (const what of wanted) {
    const built =
      what === 'node' ? buildNode(found, env) : buildWasm(found, env)
    console.log(`chat crypto ${what}: ${built.slice(root.length + 1)}`)
  }
  return 0
}

if (
  process.argv[1] != null &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main()
}
