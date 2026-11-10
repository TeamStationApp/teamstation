/**
 * Runs one legacy script from the command its header names.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import {
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { concreteEnv, headerNames, legacyCommand } from './legacyCommand'
import { STACK_API, STACK_ORIGIN } from './legacyStack'

export interface LegacyRun {
  file: string
  status: 'passed' | 'failed' | 'blocked' | 'pending'
  exit: number
  reason?: string
}

function start(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  log: string
): ChildProcess {
  const out = openSync(log, 'a')
  return spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: ['ignore', out, out]
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

function artifactDir(file: string): string {
  const dir = join(
    homedir(),
    '.cursor/artifacts/202611080444-e2eSuite/legacy',
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
    key === 'TS_ARTIFACTS_DIR'
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
    MAESTRO_D: 'e2eSuite',
    MAESTRO_D_IOS: 'e2eSuite-ios',
    MAESTRO_D_ANDROID: 'e2eSuite-android',
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

/**
 * The newest Chrome for Testing in puppeteer's cache. Its WebGL runs on
 * SwiftShader headless, it plays H.264, and it speaks the DevTools protocol of
 * the repository's puppeteer; Maestro D's own Chromium does none of those.
 */
export function testChrome(
  root = join(homedir(), '.cache/puppeteer/chrome')
): string | undefined {
  try {
    const dir = readdirSync(root)
      .filter(name => /^mac_arm-\d/.test(name))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      )
      .at(-1)
    return dir == null
      ? undefined
      : join(
          root,
          dir,
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        )
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
      ...sourceNames(source)
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
    MAESTRO_D: options.env?.MAESTRO_D ?? 'e2eSuite'
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
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            test.kill('SIGTERM')
          }, timeoutMs)
        : undefined
    const code = await exitOf(test)
    if (timer != null) clearTimeout(timer)
    return {
      file,
      status: code === 0 ? 'passed' : 'failed',
      exit: code
    }
  } finally {
    for (const server of servers) server.kill('SIGTERM')
  }
}
