import { readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

import { ROOT } from './manifest'

/**
 * The app modules a scenario category and a legacy script can belong to.
 * `pendingCategories` is this list, so a category here is not yet held to the
 * full fault catalogue.
 */
export const MODULES = [
  'account',
  'app-shell',
  'assistant',
  'messaging',
  'people',
  'platform',
  'playback',
  'schedule',
  'scoring',
  'streaming',
  'umpires'
] as const

export type ModuleName = (typeof MODULES)[number]

const PARKED_PREFIXES = [
  'mobile/apps/tsCameraman/',
  'mobile/apps/tsCameramanAndroid/',
  'mobile/apps/tsDirector/',
  'appletv/'
]

/** First match wins. `stream` is ahead of `settings`, and `chat` is ahead of `scoring`. */
const RULES: Array<{ module: ModuleName; tokens: string[] }> = [
  { module: 'messaging', tokens: ['chat'] },
  { module: 'assistant', tokens: ['tess'] },
  { module: 'umpires', tokens: ['umpire'] },
  {
    module: 'schedule',
    tokens: ['autoscheduler', 'scheduler', 'rsvp', 'season', 'league']
  },
  {
    module: 'scoring',
    tokens: [
      '/scoring/',
      'scoring-',
      'dictat',
      'lineup',
      'roster',
      'walkup',
      'runnerdrag',
      'pickoff',
      '/field/',
      'screens/game',
      'screens/event',
      'screens/coach',
      'screens/side',
      'screens/box'
    ]
  },
  {
    module: 'streaming',
    tokens: ['stream', 'ingest', 'camera', 'radar', 'upload']
  },
  {
    module: 'playback',
    tokens: [
      'replay',
      '/player/',
      'playerlayouts',
      'scoreboard',
      'playback',
      '/live/'
    ]
  },
  {
    module: 'account',
    tokens: [
      'password',
      'account',
      'oauth',
      'signin',
      'apikey',
      'settings',
      'userid',
      'googleprovider'
    ]
  },
  {
    module: 'people',
    tokens: [
      'member',
      'guardian',
      'playername',
      'relationship',
      'teamrestoration',
      'groupcreation',
      'gamecreation',
      'headcoach',
      'addpeople',
      'stats',
      'screens/team',
      'teamplayers'
    ]
  },
  {
    module: 'app-shell',
    tokens: [
      'navigation',
      'header',
      'home',
      'longlist',
      'creation',
      'navbar',
      'uifix',
      'uitweak',
      'cardspacing',
      'mapframe',
      'sentry',
      'stepdown',
      'gamehero',
      'list-screens'
    ]
  }
]

const SUITE_OR_SCRIPT = /\.(?:e2e|integration)\.[^/]+$|\.mjs$|^scripts\//

export interface ModuleAssignment {
  tests: string[]
  helpers: string[]
  parked: string[]
  modules?: Record<string, string>
  pendingCategories?: string[]
}

/** The module a legacy path belongs to, or none for a helper, a parked tree, or `tsconfig.e2e.json`. */
export function moduleOf(file: string, root = ROOT): string | undefined {
  const path = file.replaceAll('\\', '/')
  if (path === 'tsconfig.e2e.json') return undefined
  if (PARKED_PREFIXES.some(prefix => path.startsWith(prefix))) return undefined
  if (isHelper(path, root)) return undefined
  const lower = path.toLowerCase()
  for (const rule of RULES) {
    if (rule.tokens.some(token => lower.includes(token))) return rule.module
  }
  if (SUITE_OR_SCRIPT.test(path)) return 'platform'
  return undefined
}

/** Problems `validate` reports when `modules` is present. An absent map is a fixture tree and is skipped. */
export function moduleProblems(list: ModuleAssignment, root = ROOT): string[] {
  if (list.modules == null) return []
  const problems: string[] = []
  const pending = list.pendingCategories ?? []
  if (
    pending.length !== MODULES.length ||
    pending.some((name, i) => name !== MODULES[i])
  ) {
    problems.push('pendingCategories must be the module list')
  }
  const helpers = new Set(list.helpers)
  const parked = new Set(list.parked)
  for (const [file, named] of Object.entries(list.modules)) {
    if (!MODULES.includes(named as ModuleName)) {
      problems.push(`${file}: unknown module "${named}"`)
    }
    if (helpers.has(file) || parked.has(file)) {
      problems.push(`${file}: a helper or a parked path is in modules`)
    }
    const found = moduleOf(file, root)
    if (found !== named) {
      problems.push(
        `${file}: modules says ${named}, moduleOf says ${found ?? 'none'}`
      )
    }
  }
  for (const file of list.tests) {
    if (file === 'tsconfig.e2e.json') continue
    const found = moduleOf(file, root)
    if (found == null) {
      problems.push(`${file}: a runnable test has no module`)
      continue
    }
    if (list.modules[file] !== found) {
      problems.push(
        `${file}: modules says ${list.modules[file] ?? 'none'}, moduleOf says ${found}`
      )
    }
  }
  return problems
}

/** A library, a `Fixture` file, or a file whose first comment calls it a fixture or a helper. */
function isHelper(file: string, root: string): boolean {
  if (file.toLowerCase().includes('fixture')) return true
  let text = ''
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch {
    return false
  }
  const comment = firstComment(text)
    .replace(/^\/\*+|\*\/$/g, '')
    .replace(/^\/\/\s?/gm, '')
    .trim()
  if (
    /^(?:browser-only visual fixture|(?:a |the )?(?:test )?(?:fixture|helper))\b/i.test(
      comment
    )
  ) {
    return true
  }
  return isLibrary(text, file)
}

function firstComment(text: string): string {
  const block = /^\uFEFF?\s*\/\*[\s\S]*?\*\//.exec(text)
  if (block != null) return block[0]
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) lines.push(trimmed)
    else if (trimmed === '') {
      if (lines.length > 0) break
    } else break
  }
  return lines.join('\n')
}

/**
 * No `describe` callee, no `require.main`, no column-0 `main(`, no column-0
 * `await`, and not an `.mjs`. A call indented inside a function is not the entry point.
 */
function isLibrary(text: string, file: string): boolean {
  if (file.endsWith('.mjs')) return false
  const code = stripComments(text)
  if (/\bdescribe(?:\.\w+)?\)?\s*\(/.test(code)) return false
  if (/require\.main\s*===\s*module/.test(code)) return false
  if (callsMain(code)) return false
  if (/^await\s/m.test(code)) return false
  if (hasEntry(code)) return false
  return true
}

/**
 * A column-0 statement that calls something. Declarations and imports are
 * not an entry point. `;(scenarios[name] ?? fallback)()` is.
 */
function hasEntry(code: string): boolean {
  for (const line of code.split('\n')) {
    if (!/^[;(A-Za-z_]/.test(line)) continue
    if (
      /^(?:import|export|const|let|var|function|class|interface|type|enum|async\s+function|async\s+const)\b/.test(
        line
      )
    ) {
      continue
    }
    if (line.includes('(')) return true
  }
  return false
}

/** A `main(` call. A `function main(` declaration is not a call. */
function callsMain(code: string): boolean {
  const pattern = /\bmain\s*\(/g
  let found: RegExpExecArray | null
  while ((found = pattern.exec(code)) != null) {
    const before = code.slice(Math.max(0, found.index - 30), found.index)
    if (!/(?:function|class)\s*$/.test(before)) return true
  }
  return false
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm
const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '/index.ts',
  '/index.tsx'
]

/** The repository files a file imports by a relative path, resolved as sucrase does. */
export function importsOf(file: string, root = ROOT): string[] {
  let text = ''
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch {
    return []
  }
  const found: string[] = []
  for (const match of stripComments(text).matchAll(IMPORT)) {
    const base = posix.normalize(posix.join(posix.dirname(file), match[1]))
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${base}${suffix}`
      if (isFile(join(root, candidate))) {
        if (!found.includes(candidate)) found.push(candidate)
        break
      }
    }
  }
  return found
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Every file the roots reach through relative imports, the roots included. */
export function importClosure(roots: string[], root = ROOT): Set<string> {
  const seen = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file) || !isFile(join(root, file))) continue
    seen.add(file)
    pending.push(...importsOf(file, root))
  }
  return seen
}

/** Where the streaming freeze is recorded. */
export const FREEZE_FILE = 'e2e/streamingFreeze.json'

/** The code that runs the streaming tests and the streaming legacy modules today. */
export const FREEZE_RUNNERS = [
  'e2e/core/run.ts',
  'e2e/core/legacySweep.ts',
  'e2e/core/runLegacy.ts'
]

export interface StreamingFreeze {
  roots: {
    globs: string[]
    legacyModule: 'streaming'
    runners: string[]
  }
  files: string[]
}

const FREEZE_GLOBS = ['e2e/tests/streaming/**', 'e2e/rigs/streaming/**']

/**
 * Test-side files the freeze holds: everything under `e2e/` and `scripts/`,
 * `src/test/`, and every `*.e2e.*` and `*.integration.*` file. The app code
 * those reach is outside the end-to-end tree and changes with the app.
 */
function testSide(file: string): boolean {
  return (
    file.startsWith('e2e/') ||
    file.startsWith('scripts/') ||
    file.startsWith('src/test/') ||
    /\.(?:e2e|integration)\.[^/]+$/.test(file)
  )
}

/** Mocha unit tests: they run on no runner, so neither lint nor freeze roots take them. */
export function isUnitTest(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file)
}

/** The freeze's roots as files: the streaming tests and rigs, modules and runners. */
export function freezeRoots(
  tracked: string[],
  list: ModuleAssignment
): string[] {
  const underGlobs = tracked.filter(
    file =>
      (file.startsWith('e2e/tests/streaming/') ||
        file.startsWith('e2e/rigs/streaming/')) &&
      !isUnitTest(file)
  )
  const modules = Object.entries(list.modules ?? {})
    .filter(([, named]) => named === 'streaming')
    .map(([file]) => file)
  return [...underGlobs, ...modules, ...FREEZE_RUNNERS]
}

/** The streaming freeze computed from its roots, as `e2e/streamingFreeze.json` records it. */
export function computeFreeze(
  tracked: string[],
  list: ModuleAssignment,
  root = ROOT
): StreamingFreeze {
  const reached = importClosure(freezeRoots(tracked, list), root)
  // The freeze's own tests come with it: those under its globs, and the test
  // beside each end-to-end file it holds.
  for (const file of tracked) {
    if (!isUnitTest(file) || !file.startsWith('e2e/')) continue
    const subject = file.replace(
      /(?:\.integration)?\.test(\.[cm]?[jt]sx?)$/,
      '$1'
    )
    if (
      file.startsWith('e2e/tests/streaming/') ||
      file.startsWith('e2e/rigs/streaming/') ||
      reached.has(subject)
    ) {
      reached.add(file)
    }
  }
  return {
    roots: {
      globs: FREEZE_GLOBS,
      legacyModule: 'streaming',
      runners: FREEZE_RUNNERS
    },
    files: [...reached].filter(testSide).sort()
  }
}

export function renderFreeze(freeze: StreamingFreeze): string {
  return `${JSON.stringify(freeze, null, 2)}\n`
}

/** The committed freeze, or undefined when none is committed. */
export function readFreeze(root = ROOT): StreamingFreeze | undefined {
  try {
    return JSON.parse(
      readFileSync(join(root, FREEZE_FILE), 'utf8')
    ) as StreamingFreeze
  } catch {
    return undefined
  }
}

/** A committed freeze that differs from the one its roots compute. */
export function freezeProblems(
  tracked: string[],
  list: ModuleAssignment,
  root = ROOT
): string[] {
  const stored = readFreeze(root)
  if (stored == null) {
    return [`${FREEZE_FILE} is missing: run \`e2e freeze\``]
  }
  const fresh = computeFreeze(tracked, list, root)
  if (renderFreeze(stored) === renderFreeze(fresh)) return []
  const was = new Set(stored.files)
  const now = new Set(fresh.files)
  const added = fresh.files.filter(file => !was.has(file))
  const dropped = stored.files.filter(file => !now.has(file))
  const detail = [
    ...added.map(file => `+${file}`),
    ...dropped.map(file => `-${file}`)
  ]
  return [
    `${FREEZE_FILE} differs from its roots${detail.length > 0 ? ` (${detail.join(', ')})` : ''}: run \`e2e freeze\``
  ]
}

/**
 * Rigs the lint waits on: under `e2e/rigs/`, reached by no spec under
 * `e2e/tests/` and by at least one unconverted legacy module or helper. A
 * category's commit converts their modules, and the rig is linted from then.
 */
export function legacyOnlyRigs(
  tracked: string[],
  list: ModuleAssignment,
  root = ROOT
): Set<string> {
  const specs = tracked.filter(
    file => file.startsWith('e2e/tests/') && !isUnitTest(file)
  )
  const bySpecs = importClosure(specs, root)
  const legacy = [...Object.keys(list.modules ?? {}), ...list.helpers]
  const byLegacy = importClosure(legacy, root)
  const skipped = new Set<string>()
  for (const file of byLegacy) {
    if (file.startsWith('e2e/rigs/') && !bySpecs.has(file)) skipped.add(file)
  }
  return skipped
}
