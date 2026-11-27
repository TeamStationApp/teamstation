import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  encode,
  frames,
  framesText,
  lastFramesText,
  OCR_SCRIPT,
  recordScreen,
  type RunTool,
  splitFrames,
  videoSeconds,
  videoSize
} from './video'

/** A stand-in for spawned FFmpeg: what it was asked, and what it prints. */
function fakeSpawn(
  stdout: Uint8Array,
  code = 0
): { run: any; calls: string[][] } {
  const calls: string[][] = []
  const run = ((_command: string, args: string[]) => {
    calls.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough }
    child.stdout = new PassThrough()
    setImmediate(() => {
      child.stdout.end(stdout)
      setImmediate(() => child.emit('close', code))
    })
    return child
  }) as any
  return { run, calls }
}

/** A stand-in for `spawnSync`: each call's tool and arguments, and its answer. */
function fakeRun(
  answer: (
    file: string,
    args: string[]
  ) => Partial<{ status: number; stdout: string; stderr: string }>
): { run: RunTool; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = []
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args })
      return { status: 0, stdout: '', stderr: '', ...answer(file, args) }
    }
  }
}

const DESCRIBED =
  '  Duration: 00:00:12.50, start: 0.000000, bitrate: 10 kb/s\n' +
  '  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1179x2556, 60 fps\n'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'video-test-'))
}

describe('the video layer', function () {
  it('records the device through maestro-d around the action and keeps the file', async function () {
    const dir = scratch()
    try {
      const steps: string[] = []
      const device = {
        startRecording: async (options: { path: string }) => {
          steps.push(`start ${options.path}`)
        },
        stopRecording: async (options: { path: string }) => {
          steps.push(`stop ${options.path}`)
          return { data: 'recordings/motion-2.mp4' }
        },
        artifact: async (file: string) => {
          steps.push(`fetch ${file}`)
          return Buffer.from('movie')
        }
      }
      const kept = await recordScreen(
        device,
        dir,
        'motion',
        async () => {
          steps.push('action')
        },
        () => 42
      )
      expect(steps).deep.equals([
        'start motion',
        'action',
        'stop motion',
        'fetch recordings/motion-2.mp4'
      ])
      expect(kept).deep.equals({
        file: join(dir, 'motion.mp4'),
        startedAtMs: 42
      })
      expect(readFileSync(kept.file, 'utf8')).equals('movie')
      // A failed action is still recorded, kept as evidence, and still fails;
      // a stop that names no file reads the name it was given.
      const fetched: string[] = []
      let failure: unknown
      await recordScreen(
        {
          ...device,
          stopRecording: async () => ({}),
          artifact: async (file: string) => {
            fetched.push(file)
            return Buffer.from('partial')
          }
        },
        join(dir, 'nested'),
        'broken',
        async () => {
          throw new Error('the action failed')
        }
      ).catch((error: unknown) => {
        failure = error
      })
      expect(String(failure)).includes('the action failed')
      expect(fetched).deep.equals(['recordings/broken.mp4'])
      expect(readFileSync(join(dir, 'nested', 'broken.mp4'), 'utf8')).equals(
        'partial'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a recording’s picture size and length, and refuses one with neither', function () {
    const { run } = fakeRun(() => ({ status: 1, stderr: DESCRIBED }))
    expect(videoSize('/run/a.mp4', run)).deep.equals({
      width: 1179,
      height: 2556
    })
    expect(videoSeconds('/run/a.mp4', run)).equals(12.5)
    const empty = fakeRun(() => ({ stderr: 'nothing here' })).run
    expect(() => videoSize('/run/b.mp4', empty)).throws('no picture')
    expect(() => videoSeconds('/run/b.mp4', empty)).throws('no duration')
    // By default FFmpeg itself is asked: a file that is not there has no picture.
    expect(() => videoSize(join(tmpdir(), 'no-such-recording.mp4'))).throws()
  })

  it('reads a recording back as cropped grayscale frames', async function () {
    const crop = { width: 4, height: 2, x: 1, y: 2 }
    const raw = new Uint8Array(4 * 2 * 3 + 5).fill(9)
    const { run, calls } = fakeSpawn(raw)
    const read = await frames('/run/motion.mp4', crop, run)
    expect(read).length(3)
    expect(read[0].data).length(8)
    expect(calls[0]).includes('crop=4:2:1:2,crop=4:ih:(iw-4)/2:0,format=gray')
    let error: unknown
    await frames(
      '/run/bad.mp4',
      crop,
      fakeSpawn(new Uint8Array(0), 1).run
    ).catch((caught: unknown) => {
      error = caught
    })
    expect(String(error)).includes('/run/bad.mp4')
    // A crop turned a quarter comes back upright: its sides swapped, and
    // kept as the strip down its middle.
    const turned = fakeSpawn(new Uint8Array(2 * 4 * 2))
    const upright = await frames(
      '/run/motion.mp4',
      { ...crop, turn: 'cw' },
      turned.run
    )
    expect([upright[0].width, upright[0].height]).deep.equals([2, 4])
    expect(turned.calls[0]).includes(
      'crop=4:2:1:2,transpose=1,crop=2:ih:(iw-2)/2:0,format=gray'
    )
    const ccw = fakeSpawn(new Uint8Array(0))
    await frames('/run/motion.mp4', { ...crop, turn: 'ccw' }, ccw.run)
    expect(ccw.calls[0].join(' ')).includes('transpose=2')
    expect(splitFrames(new Uint8Array(7), 2, 2)).length(1)
  })

  it('reads a stretch of a recording’s text with macOS Vision, and leaves no frames', function () {
    const dir = scratch()
    try {
      const { run, calls } = fakeRun((file, args) => {
        if (file === 'ffmpeg' && args.includes('-ss')) {
          const out = args.at(-1)!.replace('f%04d.png', '')
          writeFileSync(join(out, 'f0001.png'), '')
          writeFileSync(join(out, 'f0002.png'), '')
          return {}
        }
        if (file === 'ffmpeg') return { stderr: DESCRIBED }
        return {
          stdout: [
            'warming up',
            JSON.stringify({ file: args[2], lines: ['Options chosen'] }),
            JSON.stringify({ file: args[1], lines: ['Building schedule'] })
          ].join('\n')
        }
      })
      const read = framesText('/run/a.mp4', dir, -2, 3, 4, run)
      expect(read).deep.equals([
        { atSec: 0.25, lines: ['Options chosen'] },
        { atSec: 0, lines: ['Building schedule'] }
      ])
      expect(calls[0].args.slice(0, 6)).deep.equals([
        '-v',
        'error',
        '-ss',
        '0',
        '-i',
        '/run/a.mp4'
      ])
      expect(calls[1]).deep.include({ file: 'swift' })
      expect(calls[1].args[0]).equals(OCR_SCRIPT)
      expect(existsSync(OCR_SCRIPT)).equals(true)
      expect(readdirSync(dir)).deep.equals([])
      // The last seconds: from the length less those, to the end.
      const last = fakeRun((file, args) =>
        file === 'ffmpeg' && !args.includes('-ss') ? { stderr: DESCRIBED } : {}
      )
      expect(lastFramesText('/run/a.mp4', dir, 10, 4, last.run)).deep.equals([])
      expect(last.calls[1].args).includes('2.5')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says why a stretch could not be cut or read', function () {
    const dir = scratch()
    try {
      const cut = fakeRun(() => ({ status: 1, stderr: 'bad input' })).run
      expect(() => framesText('/run/a.mp4', dir, 0, 1, 4, cut)).throws(
        'could not cut'
      )
      const unread = fakeRun((file, args) => {
        if (file === 'ffmpeg') {
          writeFileSync(
            join(args.at(-1)!.replace('f%04d.png', ''), 'f0001.png'),
            ''
          )
          return {}
        }
        return { status: 1, stderr: 'no Vision' }
      }).run
      expect(() => framesText('/run/a.mp4', dir, 0, 1, 4, unread)).throws(
        'not read'
      )
      expect(readdirSync(dir)).deep.equals([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('encodes painted frames, each shown until the next, and removes them', function () {
    const dir = scratch()
    try {
      let list = ''
      const { run, calls } = fakeRun((_file, args) => {
        list = readFileSync(args[args.indexOf('-i') + 1], 'utf8')
        return {}
      })
      encode(
        [
          { image: Buffer.from('a'), at: 1 },
          { image: Buffer.from('b'), at: 1.25 }
        ],
        '/run/web-build.mp4',
        dir,
        run
      )
      expect(calls[0].args.at(-1)).equals('/run/web-build.mp4')
      expect(list).matches(/frame-00000\.jpg'\nduration 0\.250\n/)
      expect(list).matches(/frame-00001\.jpg'\nduration 0\.500\n/)
      expect(list.trim().split('\n').at(-1)).matches(/frame-00001\.jpg'$/)
      expect(readdirSync(dir)).deep.equals([])
      expect(() => {
        encode([], '/run/none.mp4', dir, run)
      }).throws('No frames were painted')
      const failing = fakeRun(() => ({ status: 1, stderr: 'no codec' })).run
      expect(() => {
        encode([{ image: Buffer.from('a'), at: 0 }], '/run/x.mp4', dir, failing)
      }).throws('FFmpeg failed: no codec')
      expect(readdirSync(dir)).deep.equals([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
