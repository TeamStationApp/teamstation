/** Own one local fault relay; its control token and audit remain private. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { RecoveryFaults } from '../src/test/chatRecoveryFaults'
import {
  type RecoveryFixtureOwner,
  validateRecoveryOwner
} from '../src/test/chatRecoveryFixtureContract'
import { recoveryRelay } from '../src/test/chatRecoveryRelay'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      out: { type: 'string' }
    }
  })
  assert(values.out != null && values.port != null)
  const port = Number(values.port)
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535)
  const ownerFile = process.env.CHAT_RECOVERY_OWNER_FILE
  assert(ownerFile != null)
  const owner = JSON.parse(
    readFileSync(ownerFile, 'utf8')
  ) as RecoveryFixtureOwner
  const settings = JSON.parse(readFileSync('serverConfig.json', 'utf8')) as {
    databaseUrl: string
    listenPort: number
  }
  const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8' }).trim()
  validateRecoveryOwner(owner, {
    source: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    databaseUrl: settings.databaseUrl
  })
  assert.equal(Number(new URL(owner.apiUrl).port), settings.listenPort)
  assert.notEqual(port, settings.listenPort)
  const out = resolve(values.out)
  assert(out.startsWith(resolve(owner.artifacts) + '/'))
  mkdirSync(out, { mode: 0o700 })
  const audit = join(out, 'audit.jsonl')
  writeFileSync(audit, '', { mode: 0o600, flag: 'wx' })
  const token = randomBytes(32).toString('hex')
  const faults = new RecoveryFaults(row => {
    appendFileSync(audit, JSON.stringify(row) + '\n', { mode: 0o600 })
  })
  const relay = await recoveryRelay({
    disposable: true,
    upstream: new URL(owner.apiUrl).origin,
    controlToken: token,
    faults,
    allowedOrigins: [new URL(owner.webUrl).origin],
    port,
    host: '127.0.0.1'
  })
  try {
    writeFileSync(
      join(out, 'ready.json'),
      JSON.stringify(
        {
          disposable: true,
          source: owner.source,
          branch: owner.branch,
          upstream: owner.apiUrl,
          endpoint: `http://127.0.0.1:${relay.port}/__recovery_fault`,
          token,
          audit,
          pid: process.pid
        },
        null,
        2
      ),
      { mode: 0o600, flag: 'wx' }
    )
    console.log('READY owned recovery relay; private control settings written')
    await new Promise<void>(resolve => {
      process.once('SIGTERM', resolve)
      process.once('SIGINT', resolve)
    })
  } finally {
    await relay.close()
  }
  writeFileSync(
    join(out, 'closed.json'),
    JSON.stringify({
      source: owner.source,
      cleared: true,
      socketsClosed: true
    }),
    { mode: 0o600, flag: 'wx' }
  )
  console.log('PASS relay stopped, gates cleared and sockets closed')
}

main().catch(() => {
  console.error(
    'Owned recovery relay failed; inspect the private fixture configuration'
  )
  process.exitCode = 1
})
