import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSettings } from './settings'

/**
 * A chat history recovery fixture a run starts from: the producer
 * (`scripts/chat-history-recovery-fixtures.ts`) with this runner, scenario
 * and surface, whose exported environment the run is given.
 */
export interface ChatFixture {
  runner: 'web' | 'native' | 'reply' | 'entity' | 'chat2'
  scenario: string
  surface?: 'web' | 'ios' | 'android'
}

/** Where the stack this sweep runs serves, as the producer's owner file names it. */
export interface FixtureStack {
  databaseUrl: string
  apiUrl: string
  webUrl: string
  env: Record<string, string>
}

/**
 * The values of a producer's `env.sh`: lines `export NAME='value'`, a quote
 * in a value written `'\''` (`recoveryFixtureEnvironment`).
 */
export function readFixtureEnvironment(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^export ([A-Z][A-Z0-9_]*)='(.*)'$/.exec(line)
    if (match == null) continue
    values[match[1]] = match[2].replaceAll("'\\''", "'")
  }
  return values
}

/**
 * Runs the producer for `fixture` against `stack`, and answers the
 * environment it exported. The owner file says the database, API and web
 * app are the stack's, and is checked against the checkout and the server's
 * configuration before anything is seeded; the producer refuses a branch
 * other than `paul/<name>`, a database other than `TeamStation_<name>`, and a
 * checkout with changes. Its outputs, synthetic accounts' passwords among
 * them, stay in a private directory of this machine's, never with the
 * artifacts.
 */
export async function chatFixtureEnv(
  cwd: string,
  name: string,
  fixture: ChatFixture,
  stack: FixtureStack
): Promise<Record<string, string>> {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const root = join(tmpdir(), 'teamstation-chat-fixtures', name)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const ownerFile = join(root, 'owner.json')
  writeFileSync(
    ownerFile,
    JSON.stringify({
      disposable: true,
      source: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current'),
      databaseUrl: stack.databaseUrl,
      apiUrl: stack.apiUrl,
      webUrl: stack.webUrl,
      artifacts: root
    }),
    { mode: 0o600 }
  )
  const surface = fixture.surface ?? 'web'
  // The producer makes its output itself, and refuses one already there.
  const out = join(
    root,
    `${fixture.runner}-${fixture.scenario}-${surface}-${Date.now()}`
  )
  // The browser helpers it runs find maestro-d where the e2e settings say.
  const settings = loadSettings()
  const maestro: Record<string, string> = {
    ...(settings.maestroClientRoot == null
      ? {}
      : {
          MAESTRO_D_CLIENT_ROOT: settings.maestroClientRoot,
          TS_MAESTRO_D_CLIENT: settings.maestroClientRoot
        }),
    ...(settings.maestroBin == null
      ? {}
      : { MAESTRO_D_BIN: settings.maestroBin })
  }
  const { code, stdout } = await new Promise<{
    code: number | null
    stdout: string
  }>(resolve => {
    let text = ''
    const child = spawn(
      process.execPath,
      [
        '-r',
        'sucrase/register',
        'scripts/chat-history-recovery-fixtures.ts',
        '--runner',
        fixture.runner,
        '--scenario',
        fixture.scenario,
        '--surface',
        surface,
        '--out',
        out
      ],
      {
        cwd,
        env: {
          ...process.env,
          ...stack.env,
          ...maestro,
          CHAT_RECOVERY_OWNER_FILE: ownerFile
        },
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    child.stdout.on('data', (bytes: Buffer) => (text += String(bytes)))
    child.on('close', exit => {
      resolve({ code: exit, stdout: text })
    })
  })
  const printed = stdout.trim().split('\n').at(-1) ?? ''
  if (code !== 0 || !existsSync(printed)) {
    // The producer keeps its error, with the seed's passwords withheld,
    // beside its output; only that it failed is said here.
    const why = join(out, 'prepare-error.txt')
    throw new Error(
      `the ${fixture.runner} ${fixture.scenario} fixture failed` +
        (existsSync(why)
          ? `: ${readFileSync(why, 'utf8').split('\n')[0].slice(0, 300)}`
          : '')
    )
  }
  return readFixtureEnvironment(readFileSync(printed, 'utf8'))
}
