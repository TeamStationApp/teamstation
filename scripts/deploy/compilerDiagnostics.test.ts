import assert from 'node:assert/strict'
import { rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { testRoot } from './config.test'
import { Processes } from './process'

describe('compiler failure diagnostics', () => {
  let root: string
  let output: string[]
  let original: typeof console.error
  beforeEach(() => {
    root = testRoot('compiler-diagnostics-')
    symlinkSync(process.execPath, path.join(root, 'gradlew'))
    symlinkSync(process.execPath, path.join(root, 'security'))
    output = []
    original = console.error
    console.error = (...args: unknown[]) => {
      output.push(args.join(' '))
    }
  })
  afterEach(() => {
    console.error = original
    rmSync(root, { recursive: true, force: true })
  })
  const run = async (
    script: string,
    env?: NodeJS.ProcessEnv,
    tool = 'gradlew'
  ): Promise<string> =>
    await new Processes(new AbortController().signal).run({
      file: path.join(root, tool),
      args: ['-e', script],
      cwd: root,
      env,
      capture: false
    })

  it('reports compiler failures while redacting split and encoded credentials', async () => {
    const secret = 'fixture:sensitive/值@with spaces'
    await assert.rejects(
      run(
        "process.stdout.write('error: no cargo\\n');" +
          "const bytes=Buffer.from(process.env.BUILD_PASSWORD);const split=bytes.indexOf(Buffer.from('值'))+1;" +
          'process.stdout.write(bytes.subarray(0, split));' +
          "setTimeout(() => { process.stdout.write(bytes.subarray(split));process.stdout.write('\\n');" +
          "process.stderr.write(encodeURIComponent(process.env.BUILD_PASSWORD) + '\\n');" +
          "process.stderr.write(process.env.BUILD_PIN + '\\n');" +
          "process.stderr.write('TS_SENTRY_DSN=fixture-dsn\\n');process.exit(1) }, 10)",
        { BUILD_PASSWORD: secret, BUILD_PIN: 'fixture-pin-value' }
      ),
      /Deployment tool failed/
    )
    const log = output.join('\n')
    assert.match(log, /error: no cargo/)
    assert(!log.includes(secret))
    assert(!log.includes(encodeURIComponent(secret)))
    assert(!log.includes('fixture-dsn'))
    assert(!log.includes('fixture-pin-value'))
  })

  it('drops oversized lines and bounds retained output after redaction', async () => {
    await assert.rejects(
      run(
        "process.stdout.write('x'.repeat(100000) + '\\n');" +
          "for (let i = 0; i < 1000; i++) process.stdout.write('compiler context '.repeat(5) + '\\n');" +
          "process.stderr.write('error: useful failure\\n');process.exit(1)"
      )
    )
    const log = output.join('\n')
    assert.match(log, /error: useful failure/)
    assert(log.length <= 32 * 1024 + 100)
    assert(!log.includes('x'.repeat(100)))
  })

  it('keeps successful compiler output and failed signing-tool output private', async () => {
    assert.equal(await run("process.stdout.write('private output')"), '')
    await assert.rejects(
      run(
        "process.stderr.write('private signing output');process.exit(1)",
        undefined,
        'security'
      )
    )
    assert.deepEqual(output, ['security failed (exit 1)'])
  })
})
