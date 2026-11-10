import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { RunResult } from './result'
import { BlockedError } from './result'

/**
 * Golden images: PNGs in a private store, content-addressed, pinned from the published
 * repository by hash. Only `acceptGolden` creates one, so a nightly can never baseline
 * a broken screen.
 */
export interface GoldenEntry {
  sha256: string
  size: number
  masks: unknown[]
}

export interface GoldenManifest {
  goldens: Record<string, GoldenEntry>
}

const MAX_GOLDEN_BYTES = 5 * 1024 * 1024
const STORE_REPOSITORY = 'teamstation-e2e-goldens'
/** The only seat whose data is known to be invented. */
const FIXTURE_SEATS = ['tester']

export function goldenKey(
  scenario: string,
  checkpoint: string,
  surface: string,
  deviceClass: string
): string {
  return `${scenario}/${checkpoint}/${surface}@${deviceClass}`
}

/**
 * A class of device, never a device: nothing here can name a person's phone, because
 * the key is published.
 */
export function deviceClassOf(info: {
  platform: string
  isSimulator?: boolean
  osVersion?: string
  screenWidth?: number
  screenHeight?: number
}): string {
  const kind = info.isSimulator === true ? 'simulator' : 'device'
  const major = (info.osVersion ?? 'unknown').split('.')[0]
  const size = `${info.screenWidth ?? 0}x${info.screenHeight ?? 0}`
  return `${info.platform}-${kind}-${size}-${major}`
}

/** Chromium's class is its window and its major version, as an OS's would be. */
export function browserClassOf(
  version: string,
  size: { width: number; height: number }
): string {
  const major = /\/(\d+)\./.exec(version)?.[1] ?? 'unknown'
  return `chromium-${size.width}x${size.height}-${major}`
}

export function manifestPath(root: string): string {
  return join(root, 'e2e', 'goldens', 'manifest.json')
}

export function readGoldenManifest(root: string): GoldenManifest {
  const path = manifestPath(root)
  if (!existsSync(path)) return { goldens: {} }
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenManifest
}

export function writeGoldenManifest(
  root: string,
  manifest: GoldenManifest
): void {
  const path = manifestPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const goldens = Object.fromEntries(
    Object.entries(manifest.goldens).sort(([a], [b]) => (a < b ? -1 : 1))
  )
  writeFileSync(path, JSON.stringify({ goldens }, null, 2) + '\n')
}

/** Without a hook's variables, which would point every command at another repository. */
function storeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
    env[name] = undefined
  }
  return env
}

function git(store: string, args: string[], env = storeEnv()): string {
  return execFileSync('git', args, {
    cwd: store,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function goldenPath(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}.png`
}

/** `master` first, then dated branches newest first, as a lookup should try them. */
export function storeRefs(store: string): string[] {
  const refs = git(store, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes/origin/master',
    'refs/remotes/origin/master.*'
  ])
    .split('\n')
    .filter(Boolean)
  const dated = refs.filter(ref => ref !== 'origin/master').sort()
  dated.reverse()
  return [...refs.filter(ref => ref === 'origin/master'), ...dated]
}

/** The golden's bytes from any branch that has it, or undefined when none does. */
export function readGolden(store: string, sha256: string): Buffer | undefined {
  for (const ref of storeRefs(store)) {
    const shown = spawnSync('git', ['show', `${ref}:${goldenPath(sha256)}`], {
      cwd: store,
      env: storeEnv(),
      maxBuffer: MAX_GOLDEN_BYTES * 2
    })
    if (shown.status === 0) return shown.stdout
  }
  return undefined
}

export function syncStore(store: string): string[] {
  git(store, [
    'fetch',
    '--prune',
    'origin',
    '+refs/heads/master:refs/remotes/origin/master',
    '+refs/heads/master.*:refs/remotes/origin/master.*'
  ])
  return storeRefs(store)
}

export function requireStore(store: string | undefined): string {
  if (store == null || !existsSync(join(store, '.git'))) {
    throw new BlockedError(
      'no golden store: set goldenStore in the local settings and clone it there'
    )
  }
  return store
}

export interface VisualRecord {
  key?: string
  capturePath?: string
  mask?: unknown[]
}

export interface AcceptOptions {
  root: string
  store: string | undefined
  runDir: string
  checkpoint: string
  headRef: string
}

/** Promotes one run's stored capture: bytes to the store, the hash to the manifest. */
export function acceptGolden(options: AcceptOptions): {
  key: string
  sha256: string
} {
  const store = requireStore(options.store)
  const result = JSON.parse(
    readFileSync(join(options.runDir, 'result.json'), 'utf8')
  ) as RunResult
  if (result.ref !== options.headRef) {
    throw new Error(
      `The run is from ${result.ref} and this checkout is at ${options.headRef}`
    )
  }
  if (result.fault != null) {
    throw new Error(`The run injected ${result.fault}: it cannot make a golden`)
  }
  const target = result.target
  const onFixtures =
    target?.kind === 'isolated' ||
    (target?.kind === 'seat' && FIXTURE_SEATS.includes(target.seat ?? ''))
  if (!onFixtures) {
    throw new Error(
      'A golden can only come from a run on fixture data: the tester seat or an isolated stack'
    )
  }
  const records = result.checkpoints as Array<{
    id: string
    visual?: VisualRecord
  }>
  const visual = records.find(row => row.id === options.checkpoint)?.visual
  if (visual?.capturePath == null || visual.key == null) {
    throw new Error(`The run has no capture for "${options.checkpoint}"`)
  }
  if (!existsSync(visual.capturePath)) {
    throw new Error(`The capture is gone: ${visual.capturePath}`)
  }
  const size = statSync(visual.capturePath).size
  if (size > MAX_GOLDEN_BYTES) {
    throw new Error(`The capture is ${size} bytes, over the 5 MB limit`)
  }
  const bytes = readFileSync(visual.capturePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  syncStore(store)
  git(store, ['checkout', '-q', 'master'])
  git(store, ['merge', '-q', '--ff-only', 'origin/master'])
  const relative = goldenPath(sha256)
  const file = join(store, relative)
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    git(store, ['add', relative])
    git(store, ['commit', '-q', '-m', `Add golden ${sha256.slice(0, 12)}`])
    git(store, ['push', '-q', 'origin', 'master'])
    git(store, ['fetch', '-q', 'origin', 'master'])
  }
  const manifest = readGoldenManifest(options.root)
  manifest.goldens[visual.key] = { sha256, size, masks: visual.mask ?? [] }
  writeGoldenManifest(options.root, manifest)
  return { key: visual.key, sha256 }
}

export interface RotateOptions {
  store: string
  /** The goldens to keep, as TeamStation's `master` references them. */
  keep: GoldenManifest
  date: string
}

/**
 * Retires history with no hard cutoff: the dated branch keeps every golden for its
 * month, and a new `master` with no history holds what is still referenced, plus
 * `corpus/`.
 */
export function rotateStore(options: RotateOptions): {
  dated: string
  kept: number
} {
  const { store, keep, date } = options
  const remote = git(store, ['remote', 'get-url', 'origin'])
  if (!remote.includes(STORE_REPOSITORY)) {
    throw new Error(`Refusing to rotate ${remote}: not the golden store`)
  }
  syncStore(store)
  const tip = git(store, ['rev-parse', 'origin/master'])
  const dated = `master.${date}`
  git(store, ['push', '-q', 'origin', `${tip}:refs/heads/${dated}`])

  const scratch = mkdtempSync(join(tmpdir(), 'goldens-rotate-'))
  const env = { ...storeEnv(), GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    const listed = git(store, ['ls-tree', '-r', tip]).split('\n')
    const wanted = new Set(
      Object.values(keep.goldens).map(entry => goldenPath(entry.sha256))
    )
    let kept = 0
    for (const line of listed.filter(Boolean)) {
      const [info, path] = line.split('\t')
      const [mode, , object] = info.split(' ')
      const isCorpus = path.startsWith('corpus/')
      if (!isCorpus && !wanted.has(path)) continue
      if (wanted.has(path)) kept++
      git(
        store,
        ['update-index', '--add', '--cacheinfo', `${mode},${object},${path}`],
        env
      )
    }
    const tree = git(store, ['write-tree'], env)
    const commit = git(store, [
      'commit-tree',
      tree,
      '-m',
      `Start master again from ${dated}`
    ])
    git(store, [
      'push',
      '-q',
      `--force-with-lease=master:${tip}`,
      'origin',
      `${commit}:refs/heads/master`
    ])
    syncStore(store)
    git(store, ['checkout', '-q', 'master'])
    git(store, ['reset', '-q', '--hard', 'origin/master'])
    return { dated, kept }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
