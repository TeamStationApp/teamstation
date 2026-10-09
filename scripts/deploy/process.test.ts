import assert from 'node:assert/strict'

import { afterEach, describe, it } from 'mocha'

import { describeFailure, Processes, ToolFailure } from './process'
import { forgetSecrets } from './redact'

const shell = async (
  script: string,
  env?: NodeJS.ProcessEnv
): Promise<unknown> =>
  await new Processes(new AbortController().signal)
    .run({ file: '/bin/sh', args: ['-c', script], cwd: process.cwd(), env })
    .then(
      () => undefined,
      (error: unknown) => error
    )

describe('Failed deployment tools', () => {
  afterEach(() => {
    forgetSecrets()
  })

  it('keep the end of both streams and print it redacted', async () => {
    const error = await shell(
      'echo building; echo "using $DEPLOY_STORE_PASSWORD" >&2; ' +
        'echo "MATCH_PASSWORD=inline-fixture"; echo "error: no profile" >&2; exit 3',
      { DEPLOY_STORE_PASSWORD: 'store-fixture-value' }
    )
    assert(error instanceof ToolFailure)
    assert.equal(error.message, 'Deployment tool failed')
    assert.equal(error.tool, 'sh')
    assert.equal(error.code, 3)
    const lines = describeFailure(error)
    assert.equal(lines[0], '  sh exited with 3; its last lines:')
    // The two streams interleave in whatever order they arrive.
    assert.deepEqual(lines.slice(1).sort(), [
      '  | MATCH_PASSWORD=[redacted]',
      '  | building',
      '  | error: no profile',
      '  | using [redacted]'
    ])
    assert(!lines.join('\n').includes('fixture'))
  })

  it('keep only the newest output', async () => {
    const error = await shell(
      'i=0; while [ $i -lt 3000 ]; do echo "line $i padding padding padding"; i=$((i+1)); done; exit 1'
    )
    assert(error instanceof ToolFailure)
    assert(error.output.length <= 64 * 1024)
    const lines = describeFailure(error)
    assert.equal(lines.length, 81)
    assert.equal(lines[80], '  | line 2999 padding padding padding')
  })

  it('say so when a tool printed nothing', async () => {
    assert.deepEqual(describeFailure(await shell('exit 2')), [
      '  sh exited with 2 and printed nothing'
    ])
  })

  it('name a signal when a tool was killed', () => {
    assert.deepEqual(describeFailure(new ToolFailure('xcodebuild', null, '')), [
      '  xcodebuild exited with a signal and printed nothing'
    ])
  })

  it('print nothing for any other error, whose message may be private', () => {
    assert.deepEqual(describeFailure(new Error('synthetic-private-error')), [])
    assert.deepEqual(describeFailure('text'), [])
  })
})
