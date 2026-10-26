import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Scoring (dictation's Claude model) and chat (Tess) each have a production
 * key and a test key in 1Password. Recap keys are there too and are not read.
 *
 * The server's `serverConfig.json` holds the key for the way that process is
 * used: production keys on the production server (what a master build of the
 * app talks to), and the chat test key for an interactive server. A process
 * started with `TS_CLAUDE_KEYS=test` — unit, integration and end-to-end runs —
 * spends the test keys instead, including when the file still holds a
 * production key.
 */

export type ClaudeProduct = 'scoring' | 'chat'

/** 1Password item titles in the Teamstation vault. */
export const CLAUDE_TEST_ITEM: Record<ClaudeProduct, string> = {
  scoring: 'Claude API key - scoring - test',
  chat: 'Claude API key - chat - test'
}

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'

export interface ClaudeKeyConfig {
  dictation?: {
    anthropic?: { apiKey: string; baseUrl?: string }
  }
  tess?: { apiKey?: string; baseUrl?: string; model?: string }
}

type Run = (command: string, args: readonly string[]) => string

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * The test key for `product`, from 1Password via `OP_CLI` (or `op-scotty`).
 * Undefined when the item cannot be read. The value is never logged.
 */
export function claudeTestKey(
  product: ClaudeProduct,
  env: NodeJS.ProcessEnv = process.env,
  run: Run = defaultRun
): string | undefined {
  try {
    const value = run(env.OP_CLI ?? 'op-scotty', [
      'read',
      `op://Teamstation/${CLAUDE_TEST_ITEM[product]}/credential`
    ]).trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function baseUrlFrom(
  configPath: string | undefined,
  product: ClaudeProduct
): string | undefined {
  if (configPath == null || configPath === '') return undefined
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      dictation?: { anthropic?: { baseUrl?: unknown } }
      tess?: { baseUrl?: unknown }
    }
    const base =
      product === 'scoring'
        ? raw.dictation?.anthropic?.baseUrl
        : raw.tess?.baseUrl
    return typeof base === 'string' && base !== '' ? base : undefined
  } catch {
    return undefined
  }
}

/** Scoring's test key. The config file may name a base URL and never supplies the key. */
export function scoringTestAnthropic(
  env: NodeJS.ProcessEnv = process.env,
  run?: Run
): { apiKey: string; baseUrl: string } | undefined {
  const apiKey = claudeTestKey('scoring', env, run)
  if (apiKey == null) return undefined
  return {
    apiKey,
    baseUrl:
      baseUrlFrom(env.TS_DICTATION_CONFIG ?? 'serverConfig.json', 'scoring') ??
      ANTHROPIC_BASE_URL
  }
}

/** Chat's test key, for Tess's live tests. */
export function chatTestAnthropic(
  env: NodeJS.ProcessEnv = process.env,
  run?: Run
): { apiKey: string; baseUrl: string } | undefined {
  const apiKey = claudeTestKey('chat', env, run)
  if (apiKey == null) return undefined
  return {
    apiKey,
    baseUrl:
      baseUrlFrom(env.TS_TESS_CONFIG ?? 'serverConfig.json', 'chat') ??
      ANTHROPIC_BASE_URL
  }
}

/**
 * The scoring test key, or an error that names the item and not the secret.
 * Live interpreter tests fail closed rather than spending another key.
 */
export function requireScoringTestKey(
  env?: NodeJS.ProcessEnv,
  run?: Run
): { apiKey: string; baseUrl: string } {
  const keys = scoringTestAnthropic(env, run)
  if (keys == null)
    throw new Error(
      `The Claude scoring test key is not available (${CLAUDE_TEST_ITEM.scoring}).`
    )
  return keys
}

/**
 * When this process is a test, replace configured Claude keys with the test
 * keys. Does nothing unless `TS_CLAUDE_KEYS=test`. A configured key that
 * cannot be replaced aborts the process, so a test never keeps a production key.
 */
export function installProcessClaudeKeys(
  config: ClaudeKeyConfig,
  env: NodeJS.ProcessEnv = process.env,
  read: (
    product: ClaudeProduct,
    env?: NodeJS.ProcessEnv
  ) => string | undefined = claudeTestKey
): void {
  if (env.TS_CLAUDE_KEYS !== 'test') return
  if (config.dictation?.anthropic != null) {
    const apiKey = read('scoring', env)
    if (apiKey == null)
      throw new Error(
        `Claude scoring test key is not available (${CLAUDE_TEST_ITEM.scoring}).`
      )
    config.dictation.anthropic.apiKey = apiKey
  }
  if (config.tess?.apiKey != null && config.tess.apiKey !== '') {
    const apiKey = read('chat', env)
    if (apiKey == null)
      throw new Error(
        `Claude chat test key is not available (${CLAUDE_TEST_ITEM.chat}).`
      )
    config.tess.apiKey = apiKey
  }
}
