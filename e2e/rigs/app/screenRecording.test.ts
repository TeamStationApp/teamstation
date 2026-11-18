import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  iosDeviceName,
  type RecorderProcess,
  startRecorder
} from './screenRecording'

/**
 * A recorder process as recordIosScreen.swift behaves, driven by the test:
 * `say` writes to its stdout or stderr, `exit` ends it, and `onInterrupt`
 * runs on SIGINT.
 */
function fakeRecorder(onInterrupt: (fake: Fake) => void = () => {}): {
  start: (command: string, args: readonly string[]) => RecorderProcess
  fake: Fake
  started: Array<[string, readonly string[]]>
} {
  const events = new EventEmitter()
  const fake: Fake = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: [],
    exit: code => {
      events.emit('exit', code)
    }
  }
  const started: Array<[string, readonly string[]]> = []
  return {
    fake,
    started,
    start: (command, args) => {
      started.push([command, args])
      return {
        stdout: fake.stdout,
        stderr: fake.stderr,
        kill: signal => {
          fake.signals.push(signal)
          if (signal === 'SIGINT') onInterrupt(fake)
          if (signal === 'SIGKILL') fake.exit(null)
          return true
        },
        once: (event, listener) => events.once(event, listener)
      }
    }
  }
}

interface Fake {
  stdout: PassThrough
  stderr: PassThrough
  signals: NodeJS.Signals[]
  exit: (code: number | null) => void
}

/** What `promise` failed with; fails the test if it did not. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : JSON.stringify(error)
  }
  throw new Error('expected a failure')
}

describe('the screen recording rig', function () {
  it('records until stopped, then hands the movie over and cleans up after itself', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'screen-recording-test-'))
    const movie = join(dir, 'screen.mov')
    const kept = join(dir, 'kept.mov')
    const { start, fake, started } = fakeRecorder(recorder => {
      writeFileSync(movie, 'movie')
      recorder.stdout.write('{"finished": true}\n')
      recorder.exit(0)
    })
    const recording = startRecorder(
      'swift',
      ['rec.swift', movie],
      movie,
      1000,
      start
    )
    // Its line may come in pieces.
    fake.stdout.write('{"recording": 17949903')
    fake.stdout.write('92362}\n')
    expect((await recording).startedAtMs).equals(1794990392362)
    expect(started).deep.equals([['swift', ['rec.swift', movie]]])
    await (await recording).stop(kept)
    expect(fake.signals).deep.equals(['SIGINT'])
    expect(readFileSync(kept, 'utf8')).equals('movie')
    expect(existsSync(movie)).equals(false)
    unlinkSync(kept)
    rmdirSync(dir)
  })

  it('fails with what the recorder said when it cannot start', async function () {
    const { start, fake } = fakeRecorder()
    const recording = startRecorder('swift', [], 'never.mov', 1000, start)
    fake.stderr.write('recordIosScreen: no screen-capture device named Nope\n')
    // Its stderr is read before it exits.
    await new Promise(resolve => setImmediate(resolve))
    fake.exit(1)
    const error = await failure(recording)
    expect(error).contains('exited (1) before recording')
    expect(error).contains('no screen-capture device named Nope')
  })

  it('stops a recorder that never starts recording', async function () {
    const { start, fake } = fakeRecorder()
    const error = await failure(
      startRecorder('swift', [], 'never.mov', 20, start)
    )
    expect(error).contains('did not start')
    expect(fake.signals).deep.equals(['SIGKILL'])
  })

  it('fails to stop when the recorder leaves no movie', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'screen-recording-test-'))
    const { start, fake } = fakeRecorder(recorder => {
      recorder.exit(0)
    })
    const recording = startRecorder(
      'swift',
      [],
      join(dir, 'screen.mov'),
      1000,
      start
    )
    fake.stdout.write('{"recording": 5}\n')
    const error = await failure((await recording).stop(join(dir, 'kept.mov')))
    expect(error).contains('did not finish (0)')
    expect(existsSync(join(dir, 'kept.mov'))).equals(false)
    rmdirSync(dir)
  })

  it('fails to stop, and deletes the movie, when the recorder fails finishing it', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'screen-recording-test-'))
    const movie = join(dir, 'screen.mov')
    const { start, fake } = fakeRecorder(recorder => {
      writeFileSync(movie, 'half a movie')
      recorder.stderr.write('recordIosScreen: recording failed\n')
      setImmediate(() => {
        recorder.exit(1)
      })
    })
    const recording = startRecorder('swift', [], movie, 1000, start)
    fake.stdout.write('{"recording": 5}\n')
    const error = await failure((await recording).stop(join(dir, 'kept.mov')))
    expect(error).contains('did not finish (1)')
    expect(error).contains('recording failed')
    expect(existsSync(movie)).equals(false)
    rmdirSync(dir)
  })

  it('names an iPhone as devicectl lists it, by UDID', function () {
    const list = {
      result: {
        devices: [
          {
            deviceProperties: { name: 'Fake Phone A' },
            hardwareProperties: { udid: '00000000-0000000000000001' }
          },
          {
            deviceProperties: { name: 'Fake Phone B' },
            hardwareProperties: { udid: '00000000-0000000000000002' }
          }
        ]
      }
    }
    expect(iosDeviceName(list, '00000000-0000000000000002')).equals(
      'Fake Phone B'
    )
    expect(() => iosDeviceName(list, 'nope')).throws(
      'devicectl lists no device nope'
    )
    expect(() => iosDeviceName({}, 'nope')).throws('devicectl lists no device')
  })
})
