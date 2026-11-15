import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
