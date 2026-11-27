import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { handleOf, main, needsOf, runProvider } from './cli'
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

describe('needs --json', function () {
  it('prints every field of the normalized needs, by file or by spec id', async function () {
    const byFile = needsOf(
      'e2e/tests/platform/dump-world/sign-in.e2e.ts'
    ) as Record<string, unknown>
    expect(Object.keys(byFile).sort()).deep.equals(
      [
        'apps',
        'costUsd',
        'exclusive',
        'faults',
        'file',
        'fixtures',
        'id',
        'manual',
        'minutes',
        'scenarios',
        'secrets',
        'services',
        'stack',
        'surfaces'
      ].sort()
    )
    expect(byFile).deep.include({
      id: 'platform/dump-world/sign-in',
      file: 'e2e/tests/platform/dump-world/sign-in.e2e.ts',
      stack: 'isolated',
      fixtures: ['coach-season-dump'],
      scenarios: ['coach-sees-team'],
      surfaces: {
        'web-chromium': {
          devices: [],
          browser: { role: 'browser', needs: [], placement: 'droplet' }
        }
      }
    })
    expect(needsOf('platform/dump-world/sign-in')).deep.equals(byFile)
    expect(() => needsOf('no/such/spec')).to.throw('No spec "no/such/spec"')
    const printed: string[] = []
    const log = console.log
    console.log = (line: string) => printed.push(line)
    try {
      expect(
        await main(['needs', 'platform/dump-world/sign-in', '--json'])
      ).equals(0)
    } finally {
      console.log = log
    }
    expect(JSON.parse(printed.join('\n'))).deep.equals(byFile)
    expect(String(await failure(async () => await main(['needs'])))).contains(
      'needs wants <test file | spec id>'
    )
    expect(
      String(await failure(async () => await main(['dump', 'x'])))
    ).contains('dump wants <world> --stack')
  })
})

describe('the commands narrowed to the streaming freeze', function () {
  const refusal = async (argv: string[]): Promise<HarnessError> => {
    const error = await failure(async () => await main(argv))
    expect(error).instanceOf(HarnessError)
    return error as HarnessError
  }

  it('sends run on a scenario outside streaming/ to the devops runner', async function () {
    expect(
      (
        await refusal([
          'run',
          'app-shell/splash/phone-launch#frames',
          '--surface',
          'ios-app'
        ])
      ).message
    ).equals(
      'run app-shell/splash/phone-launch#frames: runs through teamstation-devops: npm run e2e -- run e2e/tests/app-shell/splash/phone-launch.e2e.ts'
    )
  })

  it('sends detect to the runner’s run --fault', async function () {
    expect(
      (
        await refusal([
          'detect',
          'assistant/chat/split-view#video-keeps-playing',
          '--fault',
          'api-hang',
          '--surface',
          'web-chromium'
        ])
      ).message
    ).equals(
      'detect assistant/chat/split-view#video-keeps-playing: runs through teamstation-devops: npm run e2e -- run e2e/tests/assistant/chat/split-view.e2e.ts --fault api-hang'
    )
  })

  it('refuses stack and prepare for a scenario outside streaming/, naming a file it has no row for', async function () {
    expect(
      (await refusal(['stack', 'up', '--for', 'no/such/spec#x'])).message
    ).equals(
      'stack no/such/spec#x: runs through teamstation-devops: npm run e2e -- run e2e/tests/no/such/spec.e2e.ts'
    )
    expect(
      (
        await refusal([
          'prepare',
          '--for',
          'account/sign-in/password#baseline-account'
        ])
      ).message
    ).contains('npm run e2e -- run e2e/tests/account/sign-in/password.e2e.ts')
  })

  it('leaves streaming scenarios on their own path', async function () {
    // The streaming path goes on to its own checks, unchanged.
    const error = await failure(
      async () => await main(['run', 'streaming/basic/four-synthetic#scrub'])
    )
    expect(String(error)).contains('run wants <scenario-id> --surface <s>')
    const prepare = await failure(
      async () =>
        await main(['prepare', '--for', 'streaming/basic/four-synthetic#scrub'])
    )
    expect(String(prepare)).contains('prepare wants --app and --device')
  })

  it('has no plan, run-many or golden command', async function () {
    for (const command of ['plan', 'run-many', 'golden']) {
      expect(String(await failure(async () => await main([command])))).contains(
        `Unknown command "${command}"`
      )
    }
  })
})
