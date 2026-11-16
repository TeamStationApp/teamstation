import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { handleOf, runProvider } from './cli'
import { BlockedError, HarnessError } from './result'

/** A provider that prints `out` and exits with `code`, recording how it was run. */
function provider(
  out: string,
  code: number
): { spawnFn: any; ran: Array<{ file: string; args: string[] }> } {
  const ran: Array<{ file: string; args: string[] }> = []
  const spawnFn = (file: string, args: string[]): any => {
    ran.push({ file, args })
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setImmediate(() => {
      child.stdout.end(out)
      child.stderr.end()
      setImmediate(() => child.emit('close', code))
    })
    return child
  }
  return { spawnFn, ran }
}

const SETTINGS = {
  stackProvider: { command: ['npm', 'run', '-s', 'e2e-stack', '--'] }
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('the stack provider', function () {
  it('runs the local settings’ command with the arguments, and answers what it printed', async function () {
    const { spawnFn, ran } = provider(
      'e2e-stack-1: teamstation develop\nhandle: /stacks/e2e-stack-1.json\n',
      0
    )
    const lines = await runProvider(
      SETTINGS,
      ['up', '--ref', 'develop'],
      spawnFn
    )
    expect(ran).deep.equals([
      {
        file: 'npm',
        args: ['run', '-s', 'e2e-stack', '--', 'up', '--ref', 'develop']
      }
    ])
    expect(handleOf(lines)).equals('/stacks/e2e-stack-1.json')
  })

  it('is blocked with no provider, and a harness error when it fails or names no handle', async function () {
    expect(
      await failure(async () => await runProvider({}, ['reap']))
    ).instanceOf(BlockedError)
    const failed = await failure(
      async () =>
        await runProvider(
          SETTINGS,
          ['up'],
          provider('every name of the pool (16) is held\n', 1).spawnFn
        )
    )
    expect(failed).instanceOf(HarnessError)
    expect(String(failed)).includes('every name of the pool (16) is held')
    expect(() => handleOf(['up failed'])).to.throw('printed no handle')
  })
})
