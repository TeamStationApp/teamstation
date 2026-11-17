import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'

import { BlockedError, HarnessError } from './result'
import {
  attachedLegacyStack,
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

  it('follows the log again when SSH cannot start, without throwing', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-attached-'))
    let tails = 0
    const stack = attachedLegacyStack(HANDLE, dir, {
      everyMs: 1000,
      spawn: command => {
        if (command !== 'ssh') return fakeChild('', true)
        tails++
        const child = fakeChild('', false)
        // Unheard, an error event is thrown.
        if (tails === 1) {
          setImmediate(() => {
            child.emit('error', new Error('spawn ssh ENOENT'))
            child.emit('exit', -2)
          })
        }
        return child
      }
    })
    await new Promise(resolve => setTimeout(resolve, 2300))
    await stack.stop()
    expect(tails).equals(2)
  }).timeout(5000)

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
