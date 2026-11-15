import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'

import { daemonNames } from './daemons'
import { attachedBlocker, sweepArgs, sweepLine } from './legacySweep'
import { BlockedError, HarnessError } from './result'
import {
  attachedLegacyStack,
  clearCodeLimits,
  mirrorCommands,
  mirrorsIn,
  nodeDatabaseUrl,
  requireStreamingHandle,
  SSH_OPTIONS,
  type StreamingHandle,
  streamingStackEnv
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

function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}

/** A child that writes `out` and exits when killed, or at once when `exits`. */
function fakeChild(out: string, exits: boolean): any {
  const child: any = new EventEmitter()
  child.stdout = new PassThrough()
  child.stdout.write(out)
  child.kill = () => {
    child.emit('exit', 0)
  }
  if (exits) {
    setImmediate(() => child.emit('exit', 0))
  }
  return child
}

describe('the streaming scripts against an attached stack', function () {
  it('needs the handle to name the API, SSH, log, HLS root and database', function () {
    expect(requireStreamingHandle(HANDLE)).equals(HANDLE)
    const error = thrown(() =>
      requireStreamingHandle({
        version: 1,
        id: 'bare',
        origin: 'https://x.test',
        ssh: ''
      })
    )
    expect(error).instanceOf(HarnessError)
    expect(error.message).includes(
      'no api, ssh, serverLog, hlsRoot, databaseUrl'
    )
  })

  it('points every origin at the stack, and every file at its mirror here', function () {
    const mirrors = mirrorsIn('/m')
    const env = streamingStackEnv(HANDLE, mirrors)
    expect(env.TS_STREAM_API).equals('https://streamtest.example.test/api/v1')
    expect(env.TS_E2E_HOST).equals('https://streamtest.example.test')
    expect(env.TS_STREAM_WEB).equals(HANDLE.origin)
    expect(env.TS_E2E_DATABASE_URL).equals(
      `${HANDLE.databaseUrl}&uselibpqcompat=true`
    )
    expect(env.TS_STREAM_SERVER_LOG).equals('/m/api.log')
    expect(env.TS_STREAM_HLS_ROOT).equals('/m/hls')
    expect(env.TS_STREAM_APP_ID).equals('app.teamstation.develop')
    expect(env).not.has.property('TS_STREAM_RTMP')
    expect(
      streamingStackEnv({ ...HANDLE, rtmp: 'rtmp://x.test/live' }, mirrors)
        .TS_STREAM_RTMP
    ).equals('rtmp://x.test/live')
    const local = Object.values(env).filter(value =>
      /127\.0\.0\.1|localhost/.test(value)
    )
    expect(local).deep.equals([])
  })

  it('mirrors over SSH that forwards nothing', function () {
    const { tail, rsync } = mirrorCommands(HANDLE, mirrorsIn('/m'))
    expect(tail[0]).equals('ssh')
    expect(tail[1].slice(-5)).deep.equals([
      'tail',
      '-n',
      '0',
      '-F',
      HANDLE.serverLog
    ])
    expect(rsync[1].slice(-2)).deep.equals([
      'stack@203.0.113.7:/example/hls/',
      '/m/hls/'
    ])
    for (const args of [tail[1], rsync[1]]) {
      expect(args.join(' ')).not.match(/(^| )-[LRD]( |$)/)
    }
    expect(SSH_OPTIONS).includes('ClearAllForwardings=yes')
    expect(SSH_OPTIONS).includes('BatchMode=yes')
  })

  it('follows the log into its mirror, copies HLS, and stops both', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-attached-'))
    const calls: string[] = []
    const stack = attachedLegacyStack(HANDLE, dir, {
      everyMs: 10,
      spawn: (command, args) => {
        calls.push(command)
        return command === 'ssh'
          ? fakeChild('line one\n', false)
          : fakeChild('', true)
      }
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    await stack.ensureApi()
    await stack.stop()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(readFileSync(stack.apiLog, 'utf8')).equals('line one\n')
    expect(calls.filter(call => call === 'ssh')).has.length(1)
    expect(calls.filter(call => call === 'rsync').length).greaterThan(1)
    expect(stack.env.TS_STREAM_SERVER_LOG).equals(stack.apiLog)
    expect(stack.speech).equals(false)
    expect(
      thrown(() => {
        stack.reseed()
      })
    ).instanceOf(BlockedError)
    let restart: unknown
    await stack.restartApi().catch((error: unknown) => (restart = error))
    expect(restart).instanceOf(BlockedError)
  })

  it('follows the log again when SSH drops', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-attached-'))
    let tails = 0
    const stack = attachedLegacyStack(HANDLE, dir, {
      everyMs: 1000,
      spawn: command => {
        if (command === 'ssh') tails++
        return fakeChild('', command === 'rsync' || tails === 1)
      }
    })
    await new Promise(resolve => setTimeout(resolve, 2300))
    await stack.stop()
    expect(tails).equals(2)
  }).timeout(5000)
})

describe('the code limits on an attached stack', function () {
  it('clears them over a connection of its own, and always lets go', async function () {
    const seen: string[] = []
    const fake = (fails: boolean) => (url: string) => ({
      connect: async () => {
        seen.push(url)
      },
      query: async (sql: string) => {
        seen.push(sql)
        if (fails) throw new Error('down')
      },
      end: async () => {
        seen.push('end')
      }
    })
    await clearCodeLimits(HANDLE, fake(false))
    expect(seen).deep.equals([
      `${HANDLE.databaseUrl}&uselibpqcompat=true`,
      "delete from rate_events where scope like 'emailCode.%'",
      "update auth_sessions set revoked_at = now() where revoked_at is null and device_name is distinct from 'Apple TV'",
      'end'
    ])
    seen.length = 0
    expect(
      await clearCodeLimits(HANDLE, fake(true)).catch(
        (e: unknown) => (e as Error).message
      )
    ).equals('down')
    expect(seen.at(-1)).equals('end')
  })
})

describe("node's view of the stack database", function () {
  it('gives sslmode=require its libpq meaning, once, and leaves other URLs alone', function () {
    const url = 'postgres://u:p@h/d?sslmode=require'
    expect(nodeDatabaseUrl(url)).equals(`${url}&uselibpqcompat=true`)
    expect(nodeDatabaseUrl(`${url}&uselibpqcompat=true`)).equals(
      `${url}&uselibpqcompat=true`
    )
    expect(nodeDatabaseUrl('postgres://u:p@h/d?sslmode=verify-full')).equals(
      'postgres://u:p@h/d?sslmode=verify-full'
    )
    expect(nodeDatabaseUrl('postgres://h/d')).equals('postgres://h/d')
  })
})

describe('the legacy sweep against an attached stack', function () {
  it('takes --stack anywhere among its arguments', function () {
    expect(sweepArgs(['out.txt', 'a.ts'])).deep.equals({
      stackId: undefined,
      rest: ['out.txt', 'a.ts']
    })
    expect(sweepArgs(['--stack', 's1', 'out.txt', 'a.ts'])).deep.equals({
      stackId: 's1',
      rest: ['out.txt', 'a.ts']
    })
    expect(() => sweepArgs(['out.txt', '--stack'])).to.throw('--stack wants')
    expect(() => sweepArgs(['--stack', '--x'])).to.throw('--stack wants')
  })

  it('blocks a script whose recipe, player games or chat seed need the sweep stack', function () {
    expect(attachedBlocker('src/app/stream/radarPairing.e2e.ts', '')).equals(
      undefined
    )
    expect(attachedBlocker('src/app/player/liveOrigin.e2e.ts', '')).includes(
      'its recipe'
    )
    expect(attachedBlocker('x.e2e.ts', 'TS_PLAYER_FIXTURE=<file>')).includes(
      'its player games'
    )
    expect(
      attachedBlocker('x.e2e.ts', "dev('seed', ADMIN.email, ADMIN.password)")
    ).includes("its seed, which reads the worktree's server config")
  })

  it('reads a file that ran nothing as blocked, never as passed', function () {
    const only = process.env.E2E_ONLY_LABELS
    try {
      delete process.env.E2E_ONLY_LABELS
      expect(sweepLine('a.e2e.ts', [], [])).equals(
        'blocked\t2\ta.e2e.ts\tnothing ran: its recipe lists no runs'
      )
      process.env.E2E_ONLY_LABELS = 'other'
      expect(sweepLine('a.e2e.ts', [], [])).equals(
        'blocked\t2\ta.e2e.ts\tnothing ran: E2E_ONLY_LABELS=other kept none of its runs'
      )
    } finally {
      if (only == null) delete process.env.E2E_ONLY_LABELS
      else process.env.E2E_ONLY_LABELS = only
    }
    const passed = { file: 'a.e2e.ts', status: 'passed', exit: 0 } as const
    expect(sweepLine('a.e2e.ts', [passed, passed], [{}, {}])).equals(
      'passed\t0\ta.e2e.ts\t2 runs'
    )
    expect(
      sweepLine(
        'a.e2e.ts',
        [
          passed,
          { ...passed, status: 'failed', exit: 1, reason: 'no\nscreen' }
        ],
        [{}, { label: 'tv' }]
      )
    ).equals('failed\t1\ta.e2e.ts\ttv: no screen')
  })

  it('names its daemons for the run, or keeps the suite names', function () {
    // Without a prefix, the run's own, kept in the environment for its scripts.
    const env: NodeJS.ProcessEnv = {}
    expect(daemonNames(env)).deep.equals({
      web: `e2e-${process.pid}`,
      ios: `e2e-${process.pid}-ios`,
      android: `e2e-${process.pid}-android`
    })
    expect(env.E2E_DAEMON_PREFIX).equals(`e2e-${process.pid}`)
    expect(
      daemonNames({ E2E_DAEMON_PREFIX: 'streamingBaseline-202611121400' }).ios
    ).equals('streamingBaseline-202611121400-ios')
    expect(() => daemonNames({ E2E_DAEMON_PREFIX: 'a b' })).to.throw(
      'not a daemon name'
    )
  })
})
