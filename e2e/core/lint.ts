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
  if (
    /\b(?:assertWithAI|assertNoDefectsWithAI|extractTextWithAI)\b/.test(text)
  ) {
    if (!/\/lint(?:\.test)?\.ts$/.test(file)) {
      add('no-maestro-ai', 'maestro-d has no handler for its AI commands')
    }
  }
  if (
    /from 'puppeteer|require\('puppeteer/.test(text) &&
    !file.endsWith('/browserCdp.ts')
  ) {
    add('no-puppeteer', 'drive the UI through maestro-d')
  }
  if (isTest(file) && !ASSERTION.test(text)) {
    add('needs-assertion', 'a test must check something')
  }
  return problems
}
