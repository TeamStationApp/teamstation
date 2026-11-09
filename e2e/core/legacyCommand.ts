/**
 * The shell command a legacy script's header tells us to run, rewritten for
 * this suite's daemon and devices.
 */

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
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of line.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

function splitEnv(tokens: string[]): {
  env: Record<string, string>
  argv: string[]
} {
  const env: Record<string, string> = {}
  let index = 0
  while (
    index < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])
  ) {
    const token = tokens[index]
    const eq = token.indexOf('=')
    env[token.slice(0, eq)] = token.slice(eq + 1)
    index++
  }
  return { env, argv: tokens.slice(index) }
}

function namesFile(argv: string[], file: string): boolean {
  const base = file.split('/').pop() ?? file
  return argv.some(
    arg => arg === file || arg.endsWith(`/${base}`) || arg === base
  )
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
  if (file === 'src/app/settingsCleanup3Native.e2e.ts') {
    return {
      argv: [],
      env: {},
      setup: [],
      blocked:
        'TS_SETTINGS3_NATIVE_FLOW: the repository has no flow JSON for this script'
    }
  }
  const lines = logicalLines(commentText(source))
  const setup: LegacySetup[] = []
  let chosen: { env: Record<string, string>; argv: string[] } | undefined
  for (const line of lines) {
    const parsed = splitEnv(tokenize(line))
    if (parsed.argv.length === 0) continue
    if (namesFile(parsed.argv, file)) {
      chosen = parsed
      continue
    }
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
  return { argv: chosen.argv, env: chosen.env, setup }
}
