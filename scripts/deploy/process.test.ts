import assert from 'node:assert/strict'

import { afterEach, describe, it } from 'mocha'

import { DeploymentToolError, describeFailure, Processes } from './process'
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
    assert(error instanceof DeploymentToolError)
    assert.equal(error.message, 'Deployment tool failed')
    assert.equal(error.tool, 'sh')
    assert.equal(error.exitCode, 3)
    const lines = describeFailure(error)
    // The two streams interleave in whatever order they arrive.
    assert.deepEqual([...lines].sort(), [
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
    assert(error instanceof DeploymentToolError)
    assert(!JSON.stringify(error).includes('padding'))
    // 3000 lines is about 100 KB; only the newest 64 KB is kept.
    const kept = error.lastLines(3000)
    assert(kept.length < 3000)
    assert.equal(kept.at(-1), 'line 2999 padding padding padding')
    const lines = describeFailure(error)
    assert.equal(lines.length, 80)
    assert.equal(lines[79], '  | line 2999 padding padding padding')
  })

  it('print nothing when a tool wrote nothing', async () => {
    const error = await shell('exit 2')
    assert(error instanceof DeploymentToolError)
    assert.equal(error.exitCode, 2)
    assert.deepEqual(describeFailure(error), [])
  })

  it('print nothing for any other error, whose message may be private', () => {
    assert.deepEqual(describeFailure(new Error('synthetic-private-error')), [])
    assert.deepEqual(describeFailure('text'), [])
  })
})
