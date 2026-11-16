/**
 * The shell command a legacy script's header tells us to run, rewritten for
 * this suite's daemon and devices.
 */

import { homedir } from 'node:os'

export interface LegacySettings {
  maestroClientRoot?: string
  maestroBin?: string
}

export interface LegacySetup {
  argv: string[]
  /** Serves until the test command finishes. */
  background: boolean
}

export interface LegacyCommand {
  argv: string[]
  env: Record<string, string>
  setup: LegacySetup[]
  /** Set when the script cannot run on this task. The reason is the record. */
  blocked?: string
}

const SERVING = new Set([
  'npm start',
  'npm run start.web',
  'npm run start.ingest'
])

function commentText(source: string): string {
  const lines = source.split('\n')
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start++
  if (lines[start]?.startsWith('//')) {
    const kept: string[] = []
    while (start < lines.length && lines[start].startsWith('//')) {
      kept.push(lines[start].replace(/^\/\/ ?/, ''))
      start++
    }
    return kept.join('\n')
  }
  const block = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1]
  if (block == null) return ''
  return block
    .split('\n')
    .map(line => line.replace(/^\s*\* ?/, ''))
    .join('\n')
}

function logicalLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.endsWith('\\')) {
      current += `${line.slice(0, -1).trim()} `
      continue
    }
    current += line.trim()
    if (current.trim() !== '') lines.push(current.trim())
    current = ''
  }
  if (current.trim() !== '') lines.push(current.trim())
  return lines
}

function tokenize(line: string): string[] {
  const tokens: string[] = []
  // A `<placeholder with spaces>` stays one token.
  const pattern = /"([^"]*)"|'([^']*)'|((?:[^\s<"']|<[^>]*>)+)/g
  for (const match of line.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

function isCommand(token: string): boolean {
  return (
    token === 'node' ||
    token === 'npx' ||
    token === 'npm' ||
    token === 'mocha' ||
    token.endsWith('/mocha')
  )
}

/** Drops `[...]` groups: the header's optional parts. */
function withoutOptional(tokens: string[]): string[] {
  const kept: string[] = []
  let depth = 0
  for (const token of tokens) {
    const opens = token.startsWith('[') ? 1 : 0
    const closes = token.endsWith(']') ? 1 : 0
    if (depth === 0 && opens === 0) kept.push(token)
    depth = Math.max(0, depth + opens - closes)
  }
  return kept
}

function splitEnv(tokens: string[]): {
  env: Record<string, string>
  argv: string[]
} {
  const commandAt = tokens.findIndex(isCommand)
  if (commandAt < 0) return { env: {}, argv: tokens }
  const env: Record<string, string> = {}
  for (const token of tokens.slice(0, commandAt)) {
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    const key = token.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = token.slice(eq + 1)
  }
  return { env, argv: tokens.slice(commandAt) }
}

function namesFile(argv: string[], file: string): boolean {
  const base = file.split('/').pop() ?? file
  return argv.some(
    arg => arg === file || arg.endsWith(`/${base}`) || arg === base
  )
}

/** Replaces values this suite knows and reports any placeholder still left. */
export function concreteEnv(
  env: Record<string, string>,
  known: Record<string, string> = {}
): { env: Record<string, string>; blocked?: string } {
  const next: Record<string, string> = { ...env }
  for (const [key, value] of Object.entries(known)) {
    if (value !== '' && key in next) next[key] = value
  }
  for (const [key, value] of Object.entries(next)) {
    if (value.startsWith('$HOME')) {
      next[key] = homedir() + value.slice('$HOME'.length)
    }
  }
  const left = Object.keys(next).filter(key => /[<>…[\]]/.test(next[key]))
  if (left.length > 0) {
    return { env: next, blocked: `placeholder env: ${left.join(', ')}` }
  }
  return { env: next }
}

/** Environment names the header mentions, so a runner can fill the ones it knows. */
export function headerNames(source: string): string[] {
  return [
    ...new Set(
      [...commentText(source).matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map(
        match => match[1]
      )
    )
  ]
}

function rewrite(env: Record<string, string>, settings: LegacySettings): void {
  if ('MAESTRO_D' in env) env.MAESTRO_D = 'e2eSuite'
  if ('MAESTRO_D_CLIENT_ROOT' in env && settings.maestroClientRoot != null) {
    env.MAESTRO_D_CLIENT_ROOT = settings.maestroClientRoot
  }
  if ('TS_MAESTRO_D_CLIENT' in env && settings.maestroClientRoot != null) {
    env.TS_MAESTRO_D_CLIENT = settings.maestroClientRoot
  }
  if ('MAESTRO_D_BIN' in env && settings.maestroBin != null) {
    env.MAESTRO_D_BIN = settings.maestroBin
  }
}

function fallback(source: string, file: string): LegacyCommand {
  const mocha =
    /from ['"]mocha['"]/.test(source) || /require\(['"]mocha['"]\)/.test(source)
  if (mocha) {
    const argv = [
      'npx',
      'mocha',
      '--timeout',
      '180000',
      '--exit',
      '-r',
      'sucrase/register'
    ]
    if (source.includes('scoringDomSetup.cjs')) {
      argv.push('-r', './src/test/scoringDomSetup.cjs')
    }
    if (file.endsWith('.ts')) argv.push('--extension', 'ts', file)
    else argv.push(file)
    return { argv, env: { MAESTRO_D: 'e2eSuite' }, setup: [] }
  }
  const script =
    /require\.main\s*===\s*module/.test(source) ||
    /\bmain\s*\(/.test(source) ||
    file.endsWith('.mjs')
  if (script) {
    const argv = file.endsWith('.mjs')
      ? ['node', file]
      : ['node', '-r', 'sucrase/register', file]
    return { argv, env: { MAESTRO_D: 'e2eSuite' }, setup: [] }
  }
  return {
    argv: [],
    env: {},
    setup: [],
    blocked: 'no command in the header and no mocha or main entry'
  }
}

/** The command the header names, or the mocha / node fallback the plan uses. */
export function legacyCommand(
  source: string,
  file: string,
  settings: LegacySettings = {}
): LegacyCommand {
  const lines = logicalLines(commentText(source))
  const setup: LegacySetup[] = []
  let chosen: { env: Record<string, string>; argv: string[] } | undefined
  for (const line of lines) {
    const parsed = splitEnv(withoutOptional(tokenize(line)))
    if (parsed.argv.length === 0) continue
    if (namesFile(parsed.argv, file)) {
      // The first command is the plain one; later ones are variants.
      chosen ??= parsed
      continue
    }
    // A setup line with a placeholder is the runner's to fill, not to run.
    if (parsed.argv.some(token => /[<>…]/.test(token))) continue
    const rendered = parsed.argv.join(' ')
    if (
      rendered === 'npm start' ||
      rendered.startsWith('npm run start.') ||
      rendered.startsWith('npm run build.web') ||
      rendered.endsWith('.sh') ||
      parsed.argv[0].endsWith('.sh')
    ) {
      setup.push({
        argv: parsed.argv,
        background:
          SERVING.has(rendered) || rendered.startsWith('npm run start.')
      })
    }
  }
  if (chosen == null) return fallback(source, file)
  rewrite(chosen.env, settings)
  if (!('MAESTRO_D' in chosen.env)) chosen.env.MAESTRO_D = 'e2eSuite'
  chosen.argv = chosen.argv.filter(token => !/[<>[\]]/.test(token))
  return { argv: chosen.argv, env: chosen.env, setup }
}
