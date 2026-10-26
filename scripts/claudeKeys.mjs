/**
 * Write Claude scoring and chat keys from 1Password into a serverConfig.json.
 *
 *   node scripts/claudeKeys.mjs production <file>
 *   node scripts/claudeKeys.mjs interactive <file>
 *   node scripts/claudeKeys.mjs test <file>
 *
 * production: scoring prod + chat prod. The production server, which is what
 * a master build of the app talks to.
 * interactive: scoring prod + chat test. A server a person is using.
 * test: scoring test + chat test. A server started for a test run.
 *
 * Recap keys are not written. The command prints which product it set, never
 * the key. `OP_CLI` names the 1Password CLI; the default is op-scotty.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const MODES = {
  production: { scoring: 'prod', chat: 'prod' },
  interactive: { scoring: 'prod', chat: 'test' },
  test: { scoring: 'test', chat: 'test' }
}

function op(args) {
  return execFileSync(process.env.OP_CLI ?? 'op-scotty', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function itemTitle(product, variant) {
  const name = `claude api key - ${product}`
  return variant === 'test' ? `${name} - test` : name
}

function readKey(product, variant) {
  const want = itemTitle(product, variant)
  const items = JSON.parse(
    op(['item', 'list', '--vault', 'Teamstation', '--format', 'json'])
  )
  const item = items.find(
    entry =>
      typeof entry.title === 'string' &&
      entry.title.trim().toLowerCase() === want
  )
  if (item?.id == null)
    throw new Error(`No 1Password item for ${product} ${variant}`)
  const value = op(['read', `op://Teamstation/${item.id}/credential`]).trim()
  if (value === '')
    throw new Error(`Empty 1Password item for ${product} ${variant}`)
  return value
}

function main() {
  const mode = MODES[process.argv[2]]
  const file = process.argv[3]
  if (mode == null || file == null || process.argv.length !== 4) {
    console.error(
      'usage: node scripts/claudeKeys.mjs <production|interactive|test> <serverConfig.json>'
    )
    process.exitCode = 1
    return
  }
  const config = JSON.parse(readFileSync(file, 'utf8'))
  if (config.dictation == null) {
    if (process.argv[2] === 'production') {
      console.error(
        'production config has no dictation section; scoring key not written'
      )
      process.exitCode = 1
      return
    }
    console.error('no dictation section; scoring key left unset')
  } else {
    config.dictation.anthropic = {
      ...(config.dictation.anthropic ?? {}),
      apiKey: readKey('scoring', mode.scoring)
    }
    console.error(`scoring ${mode.scoring} key set`)
  }
  config.tess = {
    ...(config.tess ?? {}),
    apiKey: readKey('chat', mode.chat)
  }
  console.error(`chat ${mode.chat} key set`)
  const tmp = join(dirname(file), `.${process.pid}.serverConfig.json`)
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  chmodSync(file, 0o600)
  // The server rewrites a config that does not match its cleaner, and a
  // service that cannot write that file then refuses to start. A full
  // server config (one with a database) is rewritten here, in that shape.
  if (typeof config.databaseUrl === 'string') canonicalize(file)
}

function canonicalize(file) {
  const scratch = mkdtempSync(join(tmpdir(), 'claude-keys-'))
  const serverConfig = join(process.cwd(), 'src/server/serverConfig.ts')
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'sucrase/register',
      '-e',
      'process.chdir(process.argv[1]);' +
        'const { makeConfig } = require("cleaner-config");' +
        'const { asServerConfig } = require(process.argv[3]);' +
        'makeConfig(asServerConfig, process.argv[2]);',
      scratch,
      file,
      serverConfig
    ],
    { cwd: process.cwd(), stdio: 'ignore' }
  )
  rmSync(scratch, { recursive: true })
  if (result.status !== 0) {
    console.error(
      'server config could not be rewritten into the form the server accepts'
    )
    process.exitCode = 1
    return
  }
  chmodSync(file, 0o600)
}

main()
