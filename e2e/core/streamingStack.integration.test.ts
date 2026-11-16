import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HarnessError } from './result'
import {
  attachedLegacyStack,
  seedStreamingFixture,
  type StreamingHandle
} from './streamingStack'

const HANDLE: StreamingHandle = {
  version: 1,
  id: 'streamtest-1',
  origin: 'https://streamtest.example.test',
  api: 'https://streamtest.example.test/api/v1/',
  ssh: 'stack@203.0.113.7',
  serverLog: '/example/api.log',
  hlsRoot: '/example/hls/',
  databaseUrl: 'postgres://u:p@db.example.test:5432/ts?sslmode=require'
}

describe('seeding the streaming world on an attached stack', function () {
  this.timeout(30000)

  /** A checkout whose fixtures script echoes its config and arguments, or fails. */
  function checkout(fails: boolean): string {
    const cwd = mkdtempSync(join(tmpdir(), 'e2e-seed-'))
    mkdirSync(join(cwd, 'node_modules/sucrase'), { recursive: true })
    writeFileSync(join(cwd, 'node_modules/sucrase/register.js'), '')
    mkdirSync(join(cwd, 'src/server/dev/fixtures'), { recursive: true })
    writeFileSync(
      join(cwd, 'src/server/dev/fixtures/cli.ts'),
      fails
        ? "process.stderr.write('no database'); process.exit(1)"
        : "const config = JSON.parse(require('fs').readFileSync('./serverConfig.json', 'utf8')); " +
            "console.log(JSON.stringify({ accounts: {}, ids: { config, args: process.argv.slice(2).join(' ') } }))"
    )
    return cwd
  }

  it('runs the fixtures script on the stack database, then deletes its config', async function () {
    const scratch = join(mkdtempSync(join(tmpdir(), 'e2e-seed-')), 'fixture')
    const fixture = await seedStreamingFixture(
      checkout(false),
      HANDLE,
      'mailbox@example.test',
      scratch
    )
    expect(fixture.ids.args).equals(
      'streaming --json --mailbox mailbox@example.test'
    )
    expect(fixture.ids.config).deep.equals({
      testSettings: true,
      databaseUrl: `${HANDLE.databaseUrl}&uselibpqcompat=true`
    })
    expect(existsSync(join(scratch, 'serverConfig.json'))).equals(false)
  })

  it('calls a failed seed or a checkout without sucrase a harness error', async function () {
    const scratch = join(mkdtempSync(join(tmpdir(), 'e2e-seed-')), 'fixture')
    const failure = async (cwd: string): Promise<unknown> =>
      await seedStreamingFixture(cwd, HANDLE, 'm@example.test', scratch).then(
        () => undefined,
        (error: unknown) => error
      )
    const failed = await failure(checkout(true))
    expect(failed).instanceOf(HarnessError)
    expect((failed as Error).message).includes('no database')
    expect(existsSync(join(scratch, 'serverConfig.json'))).equals(false)
    const bare = await failure(mkdtempSync(join(tmpdir(), 'e2e-seed-')))
    expect((bare as Error).message).includes('no sucrase')
  })
})

describe('an attached stack’s copies', function () {
  it('finish however much the copy prints, which nobody reads', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-attached-'))
    // A megabyte on each stream: far past a pipe's buffer.
    const chatty = [
      '-e',
      "const x = 'x'.repeat(1 << 20); process.stdout.write(x); process.stderr.write(x)"
    ]
    const stack = attachedLegacyStack(HANDLE, dir, {
      everyMs: 60000,
      spawn: command =>
        spawn(process.execPath, command === 'rsync' ? chatty : ['-e', ''], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
    })
    const done = await Promise.race([
      stack.ensureApi().then(() => true),
      new Promise(resolve => {
        setTimeout(() => {
          resolve(false)
        }, 10000)
      })
    ])
    await stack.stop()
    expect(done).equals(true)
  }).timeout(20000)
})
