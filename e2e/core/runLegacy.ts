/**
 * Runs one legacy script from the command its header names.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { daemonNames } from './daemons'
import { concreteEnv, headerNames, legacyCommand } from './legacyCommand'
import { STACK_API, STACK_ORIGIN } from './legacyStack'

export interface LegacyRun {
  file: string
  status: 'passed' | 'failed' | 'blocked' | 'pending'
  exit: number
  reason?: string
}

/**
 * Starts `argv` in a process group of its own, so stopping it stops what it
 * started too (`npx` runs mocha, which runs the script).
 */
function start(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  log: string
): ChildProcess {
  const out = openSync(log, 'a')
  try {
    return spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', out, out]
    })
  } finally {
    // The child has its own copy of the descriptor.
    closeSync(out)
  }
}

/**
 * Stops `child`'s whole process group, SIGTERM then SIGKILL after `graceMs`,
 * and waits for `child` to exit.
 */
export async function stopGroup(
  child: ChildProcess,
  graceMs = 10_000
): Promise<void> {
  if (child.pid == null) return
  const pid = child.pid
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  if (child.exitCode != null || child.signalCode != null) {
    // What it started may still hold a port.
    signal('SIGKILL')
    return
  }
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal('SIGKILL')
    }, graceMs)
    child.once('close', () => {
      clearTimeout(timer)
      signal('SIGKILL')
      resolve()
    })
    signal('SIGTERM')
  })
}

async function exitOf(child: ChildProcess): Promise<number> {
  return await new Promise(resolve => {
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }
    child.once('error', () => {
      finish(127)
    })
    child.on('close', code => {
      finish(code ?? 1)
    })
  })
}

/** Variables a script reads, as `process.env.X` or by name, as in `required('X')`. */
export function sourceNames(source: string): string[] {
  return [
    ...[...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1]),
    ...[...source.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)].map(
      m => m[1]
    ),
    ...[...source.matchAll(/['"`]([A-Z][A-Z0-9]*_[A-Z0-9_]+)['"`]/g)].map(
      m => m[1]
    )
  ]
}

/**
 * The source of each rig under e2e/rigs that `source` (at `file`) imports:
 * a rig reads variables of its own, such as the browser it asks for.
 */
export function rigSources(file: string, source: string): string[] {
  const found: string[] = []
  for (const [, spec] of source.matchAll(
    /from\s+['"]([^'"]*\/e2e\/rigs\/[^'"]+)['"]/g
  )) {
    const base = join(dirname(file), spec)
    for (const path of [base, `${base}.ts`]) {
      if (existsSync(path) && path.endsWith('.ts')) {
        found.push(readFileSync(path, 'utf8'))
        break
      }
    }
  }
  return found
}

function artifactDir(file: string): string {
  const dir = join(
    homedir(),
    '.teamstation-e2e/legacy',
    basename(file).replace(/\.[^.]+$/, '')
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function isArtifactKey(key: string): boolean {
  return (
    key.endsWith('_ARTIFACTS') ||
    key.endsWith('_ARTIFACT_DIR') ||
    key.endsWith('_OUT') ||
    key === 'TS_ARTIFACTS_DIR' ||
    key === 'ARTIFACT_DIR'
  )
}

function artifactEnv(
  source: string,
  file: string,
  keys: string[]
): Record<string, string> {
  const dir = artifactDir(file)
  const env: Record<string, string> = {}
  const named = new Set([...keys, ...sourceNames(source)])
  for (const key of named) {
    // Browser coverage is one JSON file; every other artifact key is a directory.
    if (key === 'TS_BROWSER_COVERAGE_OUT') {
      env[key] = join(dir, 'browser-coverage.json')
    } else if (isArtifactKey(key)) env[key] = dir
  }
  return env
}

function readSettings(env: NodeJS.ProcessEnv): {
  maestroClientRoot?: string
  maestroBin?: string
} {
  if (env.MAESTRO_D_CLIENT_ROOT != null || env.MAESTRO_D_BIN != null) {
    return {
      maestroClientRoot: env.MAESTRO_D_CLIENT_ROOT,
      maestroBin: env.MAESTRO_D_BIN
    }
  }
  try {
    const raw = JSON.parse(
      readFileSync(
        join(homedir(), '.config/teamstation-e2e/local.json'),
        'utf8'
      )
    ) as { maestroClientRoot?: string; maestroBin?: string }
    return {
      maestroClientRoot: raw.maestroClientRoot,
      maestroBin: raw.maestroBin
    }
  } catch {
    return {}
  }
}

function settingsKnown(settings: {
  maestroClientRoot?: string
  maestroBin?: string
}): Record<string, string> {
  const known: Record<string, string> = {
    MAESTRO_D: daemonNames().web,
    MAESTRO_D_IOS: daemonNames().ios,
    MAESTRO_D_ANDROID: daemonNames().android,
    TS_GUARDIAN_STAGE: 'all'
  }
  if (settings.maestroClientRoot != null) {
    known.MAESTRO_D_CLIENT_ROOT = settings.maestroClientRoot
    known.TS_MAESTRO_D_CLIENT = settings.maestroClientRoot
  }
  if (settings.maestroBin != null) known.MAESTRO_D_BIN = settings.maestroBin
  return known
}

function teamKnown(keys: string[], cwd: string): Record<string, string> {
  let id = ''
  try {
    const raw = JSON.parse(
      readFileSync(join(cwd, 'clientConfig.json'), 'utf8')
    ) as { appleTeamId?: string }
    id = raw.appleTeamId ?? ''
  } catch {
    id = ''
  }
  if (id === '') return {}
  const known: Record<string, string> = {}
  for (const key of keys) {
    if (key === 'MAESTRO_D_TEAM_ID' || key.endsWith('_TEAM_ID')) known[key] = id
  }
  return known
}

function deviceKnown(
  keys: string[],
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const ios = env.E2E_IOS_UDID ?? ''
  const android = env.E2E_ANDROID_SERIAL ?? ''
  // A key that names no platform takes the device this run is for.
  const own = env.E2E_DEVICE ?? ios
  const known: Record<string, string> = {}
  for (const key of keys) {
    if (key.startsWith('MAESTRO_') || /_(HOST|PORT|URL)$/.test(key)) continue
    if (/IOS|IPHONE/.test(key) && ios !== '') known[key] = ios
    else if (key.includes('ANDROID') && android !== '') known[key] = android
    else if (
      /UDID|_DEVICE$/.test(key) &&
      !/WEB|BROWSER/.test(key) &&
      own !== ''
    ) {
      known[key] = own
    }
  }
  return known
}

/** The stack's API and web origin, for the URL variables a script names. */
export function stackKnown(keys: string[]): Record<string, string> {
  const known: Record<string, string> = {}
  for (const key of keys) {
    if (/_API(_TEST)?(_URL)?$/.test(key)) known[key] = STACK_API
    else if (/(_TEST_URL|_WEB_URL|_WEB|_APP_URL)$/.test(key)) {
      known[key] = STACK_ORIGIN
    }
  }
  return known
}

/** Where Chrome for Testing keeps its binary, by the cache's platform prefix. */
const TEST_CHROME_BINARY: Record<string, string> = {
  mac_arm:
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  linux: 'chrome-linux64/chrome'
}

/**
 * The newest Chrome for Testing in puppeteer's cache, on a Mac or Linux. Its
 * WebGL runs on SwiftShader headless, it plays H.264, and it speaks the
 * DevTools protocol of the repository's puppeteer; Maestro D's own Chromium
 * does none of those.
 */
export function testChrome(
  root = join(homedir(), '.cache/puppeteer/chrome')
): string | undefined {
  try {
    const dir = readdirSync(root)
      .filter(name => /^(?:mac_arm|linux)-\d/.test(name))
      .sort((a, b) =>
        a
          .replace(/^[a-z_]+-/, '')
          .localeCompare(b.replace(/^[a-z_]+-/, ''), undefined, {
            numeric: true
          })
      )
      .at(-1)
    if (dir == null) return undefined
    return join(root, dir, TEST_CHROME_BINARY[dir.replace(/-.*$/, '')])
  } catch {
    return undefined
  }
}

/**
 * Variables that name the browser a script drives: puppeteer's executable, or
 * Maestro D's `browser`, which takes a binary's path as well as a name. Maestro
 * D's `chrome` is an installed Google Chrome, and without one its own Chromium,
 * which plays neither H.264 nor HEVC.
 */
const BROWSER_PATH = /(?:_BROWSER|_CHROME_PATH)$/

/** `chrome` for each variable `keys` names that holds a browser. */
export function browserKnown(
  keys: string[],
  chrome: string | null | undefined = testChrome()
): Record<string, string> {
  if (chrome == null) return {}
  const known: Record<string, string> = {}
  for (const key of keys) {
    if (BROWSER_PATH.test(key)) known[key] = chrome
  }
  return known
}

/** A header server the shared stack already runs. */
function stackServes(argv: string[]): boolean {
  const line = argv.join(' ')
  return (
    line === 'npm start' ||
    line === 'npm run start.web' ||
    line.startsWith('npm run build.web')
  )
}

export interface LegacyOptions {
  /** The shared stack's variables, when it is up. */
  stack?: Record<string, string>
  /** Arguments after the file, in place of the header's. */
  args?: string[]
  /** Values that win over everything the runner fills in. */
  env?: Record<string, string>
  /** Appended to the log's directory name, for one of several runs of a file. */
  label?: string
}

/** Runs `file` and stops any server its header started. */
export async function runLegacy(
  file: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 0,
  options: LegacyOptions = {}
): Promise<LegacyRun> {
  const source = readFileSync(file, 'utf8')
  const settings = readSettings(env)
  const command = legacyCommand(source, file, settings)
  if (command.blocked != null) {
    return { file, status: 'blocked', exit: 2, reason: command.blocked }
  }
  const named = [
    ...new Set([
      ...Object.keys(command.env),
      ...headerNames(source),
      ...sourceNames(source),
      ...rigSources(file, source).flatMap(sourceNames)
    ])
  ]
  const artifacts = artifactEnv(source, file, named)
  const stack =
    options.stack == null ? {} : { ...stackKnown(named), ...options.stack }
  const concrete = concreteEnv(command.env, {
    ...browserKnown(named),
    ...stack,
    ...(options.env ?? {}),
    ...settingsKnown(settings),
    ...deviceKnown(named, env),
    ...teamKnown(named, cwd),
    ...artifacts
  })
  if (concrete.blocked != null) {
    return { file, status: 'blocked', exit: 2, reason: concrete.blocked }
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...stack,
    ...artifacts,
    ...settingsKnown(settings),
    ...deviceKnown(named, env),
    ...teamKnown(named, cwd),
    ...browserKnown(named),
    ...concrete.env,
    ...(options.env ?? {}),
    MAESTRO_D: options.env?.MAESTRO_D ?? daemonNames().web
  }
  // For the rigs, which ask Maestro D for `chrome` (refinementsMaestro).
  childEnv.TS_CHROME_PATH ??= testChrome()
  if (options.args != null) {
    const at = command.argv.findIndex(
      token => token === file || token.endsWith('/' + file)
    )
    if (at >= 0)
      command.argv = [...command.argv.slice(0, at + 1), ...options.args]
  }
  const log = join(
    artifactDir(file),
    options.label == null ? 'run.log' : `run-${options.label}.log`
  )
  // This run's output only: an earlier run's error is not this one's.
  writeFileSync(log, '')
  const servers: ChildProcess[] = []
  try {
    for (const step of command.setup) {
      if (options.stack != null && stackServes(step.argv)) continue
      const child = start(step.argv, childEnv, cwd, log)
      if (step.background) servers.push(child)
      else {
        const code = await exitOf(child)
        if (code !== 0) {
          return { file, status: 'failed', exit: code, reason: 'setup failed' }
        }
      }
    }
    const test = start(command.argv, childEnv, cwd, log)
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            stopGroup(test).catch(() => undefined)
          }, timeoutMs)
        : undefined
    const code = await exitOf(test)
    if (timer != null) clearTimeout(timer)
    if (timedOut) {
      return {
        file,
        status: 'failed',
        exit: code,
        reason: `timed out after ${Math.round(timeoutMs / 1000)}s`
      }
    }
    return {
      file,
      status: code === 0 ? 'passed' : 'failed',
      exit: code
    }
  } finally {
    for (const server of servers) await stopGroup(server)
  }
}
