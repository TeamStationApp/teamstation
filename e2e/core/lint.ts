/** Rules every test and framework file must keep, checked from its source. */
export interface LintProblem {
  file: string
  rule: string
  detail: string
}

const PROJECT_NAME =
  /(?:^|[/-])(?:fixes|tweaks?|follow-?up|refinements?|polish|cleanup|sweep|phase-?\d+|e\d+)(?:[/.#-]|\d*\.)|\d\.(?:e2e|integration)\./i
const DEVICE_ID =
  /\b[0-9A-F]{8}-[0-9A-F]{16}\b|\b[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}\b/g
const ZERO_ID = /^0{8}-/
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/
const OPTIONAL = /\boptional:\s*true\b/
const EMAIL = /\b[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi
const GOLDEN_THRESHOLD = /\bmaxDifferingPercent:\s*([\d.]+)/g
const ASSERTION =
  /\bctx\.checkpoint\(|\bexpect\(|\bassert\b[.(]|\.assert[A-Z]\w*\(/

function isTest(file: string): boolean {
  return file.startsWith('e2e/tests/')
}

/** Lints one file's text. Rigs and fixtures join in strict mode at the end. */
export function lintFile(file: string, text: string): LintProblem[] {
  const problems: LintProblem[] = []
  const add = (rule: string, detail: string): void => {
    problems.push({ file, rule, detail })
  }
  if (OPTIONAL.test(text)) {
    add('no-optional', 'a maestro `optional: true` step can never fail')
  }
  if (EMPTY_CATCH.test(text)) {
    add('no-empty-catch', 'an empty catch hides a failure')
  }
  for (const match of text.matchAll(DEVICE_ID)) {
    if (!ZERO_ID.test(match[0].toUpperCase())) {
      add('no-device-id', `device identifier ${match[0]}`)
    }
  }
  if (isTest(file) && PROJECT_NAME.test(file)) {
    add('no-project-name', 'name a test for its behaviour, not its project')
  }
  if (!file.endsWith('/visual.ts') && text.includes('.assertScreenshot(')) {
    add('no-direct-screenshot', 'use ctx.checkpoint, not assertScreenshot')
  }
  // A checkpoint's `compare: 'ai'` asks maestro-d, with the run's budget and
  // the bar's authority; nothing else calls its AI commands.
  if (
    /\b(?:assertWithAI|assertNoDefectsWithAI|extractTextWithAI)\b/.test(text)
  ) {
    if (!/\/(?:lint|checkpoint)(?:\.test)?\.ts$/.test(file)) {
      add('no-maestro-ai', "ask through a checkpoint with compare: 'ai'")
    }
  }
  if (
    /from 'puppeteer|require\('puppeteer/.test(text) &&
    !/\/(?:browserCdp|web)\.ts$/.test(file)
  ) {
    add('no-puppeteer', 'drive the UI through maestro-d')
  }
  for (const match of text.matchAll(GOLDEN_THRESHOLD)) {
    const percent = Number(match[1])
    const from = text.lastIndexOf('{', match.index)
    const until = text.indexOf('}', match.index)
    if (percent > 1) {
      add(
        'golden-threshold',
        `${percent}% is above the 1% any golden may allow`
      )
    } else if (percent > 0.1 && !text.slice(from, until).includes('reason:')) {
      add('golden-threshold', `${percent}% is above the default: give a reason`)
    }
  }
  if (isTest(file)) {
    for (const [address] of text.matchAll(EMAIL)) {
      const reserved = address.toLowerCase().endsWith('@example.test')
      if (!reserved) {
        add('no-real-address', `${address}: use ctx.address, or example.test`)
      } else if (!/\bsendsNoMail:\s*true\b/.test(text)) {
        add('no-real-address', `${address}: mark the spec sendsNoMail: true`)
      }
    }
  }
  if (isTest(file) && !ASSERTION.test(text)) {
    add('needs-assertion', 'a test must check something')
  }
  return problems
}

/** The modules a test or rig may not import: each one reaches past maestro-d. */
const BANNED_MODULES = [
  'child_process',
  'net',
  'http',
  'https',
  'os',
  'puppeteer',
  'puppeteer-core'
]
const MODULE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](?:node:)?([\w/-]+)['"]/gm
const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
const EMAIL_IN = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi
const URL_HOST =
  /\b(?:https?|wss?|postgres(?:ql)?|redis|rtmps?|rtsps?|ftp):\/\/([^/'"`\s$?#]+)/gi
const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
const DOMAIN =
  /\b(?:[a-z0-9-]+\.)+(?:app|com|net|org|io|dev|local|internal|lan|cloud|ai)\b/i
/**
 * Names no machine of ours answers to (RFC 2606's, and `example.<tld>` as
 * text a test sends, such as a bare domain to linkify), and public pages a test expects
 * the app to show or link to: the SVG namespace and the App Store.
 */
const RESERVED_HOST =
  /(?:^|\.)(?:example|test|invalid|example\.[a-z]+|w3\.org|apps\.apple\.com)$/i
const HOST_PORT = /(?:\blocalhost|\b(?:\d{1,3}\.){3}\d{1,3}|\]):\d{2,5}\b/i
const CODE_PORT = /\bport\s*[:=]\s*\d{2,5}\b/i
const SERIAL =
  /\bemulator-\d{4}\b|\b[0-9a-f]{40}\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,16}\b/
const HOME_PATH = /\/Users\/[a-z]|\/home\/[a-z]|(?:^|[\s'"`(=])~\/|\.cursor\//
const HOME_CALL = /\bhomedir\s*\(/g

/** Blanks out comments, keeping every newline, so a finding's line stays true. */
function blankComments(text: string): string {
  return text.replace(
    /\/\*[\s\S]*?\*\/|(^|[^:\\'"`])\/\/[^\n]*/g,
    (match, lead: string | undefined) => {
      const kept = lead ?? ''
      const body = match.slice(kept.length)
      return kept + body.replace(/[^\n]/g, ' ')
    }
  )
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/**
 * `no-infra`: a test or rig holds navigation, needs and expected results
 * only. It imports nothing that starts a process, opens a socket or reads the
 * machine, reads no environment, and names no host, address, port, device
 * serial or home path; the runner and the stack own all of those.
 */
export function noInfraProblems(file: string, text: string): LintProblem[] {
  const problems: LintProblem[] = []
  const code = blankComments(text)
  const add = (index: number, detail: string): void => {
    problems.push({
      file,
      rule: 'no-infra',
      detail: `line ${lineAt(code, index)}: ${detail}`
    })
  }
  for (const match of code.matchAll(MODULE_IMPORT)) {
    const name = match[1].split('/')[0]
    if (BANNED_MODULES.includes(name)) {
      add(match.index, `imports ${match[1]}`)
    }
  }
  for (const match of code.matchAll(/\bprocess\.env\b/g)) {
    add(match.index, 'reads process.env')
  }
  if (file.endsWith('.swift')) {
    for (const match of code.matchAll(
      /\bProcessInfo\.processInfo\.environment\b|\bProcess\s*\(\s*\)/g
    )) {
      add(match.index, `${match[0]} reaches past maestro-d`)
    }
  }
  for (const match of code.matchAll(HOME_CALL)) {
    add(match.index, 'reads the home directory')
  }
  for (const match of code.matchAll(new RegExp(CODE_PORT, 'gi'))) {
    add(match.index, `port literal ${match[0]}`)
  }
  for (const match of code.matchAll(STRING)) {
    const literal = match[0].replace(EMAIL_IN, '')
    const found = literalShape(literal)
    if (found != null) add(match.index, found)
  }
  return problems
}

/** What a string literal names that only infrastructure knows, if anything. */
function literalShape(literal: string): string | undefined {
  if (HOME_PATH.test(literal)) return `home path in ${short(literal)}`
  if (HOST_PORT.test(literal)) return `port literal in ${short(literal)}`
  for (const match of literal.matchAll(URL_HOST)) {
    const host = match[1].replace(/:\d+$/, '')
    if (host === '' || RESERVED_HOST.test(host)) continue
    if (/:\d{2,5}$/.test(match[1])) return `port literal in ${short(literal)}`
    return `hostname ${host}`
  }
  if (/\blocalhost\b/i.test(literal)) return 'hostname localhost'
  if (IP.test(literal)) return `IP address in ${short(literal)}`
  const domain = DOMAIN.exec(literal)
  if (domain != null && !RESERVED_HOST.test(domain[0])) {
    return `hostname ${domain[0]}`
  }
  if (SERIAL.test(literal)) return `device serial shape in ${short(literal)}`
  return undefined
}

function short(literal: string): string {
  return literal.length > 40 ? `${literal.slice(0, 37)}…` : literal
}
