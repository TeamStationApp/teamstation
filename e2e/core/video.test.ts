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

describe('the video layer: whole frames and their times', function () {
  it('lists the packets’ times in order, and names a failed probe', async function () {
    const { frameTimes } = await import('./video')
    const ok = fakeRun(() => ({ stdout: '0.066\n0\n\n0.033\n' }))
    expect(frameTimes('a.mp4', ok.run)).deep.equals([0, 0.033, 0.066])
    expect(ok.calls[0].file).equals('ffprobe')
    expect(ok.calls[0].args).includes('packet=pts_time')
    const bad = fakeRun(() => ({ status: 1, stderr: 'no such file' }))
    expect(() => frameTimes('b.mp4', bad.run)).throws('no such file')
  })

  it('hands each whole gray frame over once, across chunk edges', async function () {
    const { eachGrayFrame } = await import('./video')
    const raw = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const { run, calls } = fakeSpawn(raw)
    const seen: number[][] = []
    const count = await eachGrayFrame(
      'c.mp4',
      { width: 2, height: 2 },
      (frame, n) => {
        expect(frame.width).equals(2)
        seen.push([n, ...frame.data])
      },
      run
    )
    expect(count).equals(3)
    expect(seen).deep.equals([
      [0, 1, 2, 3, 4],
      [1, 5, 6, 7, 8],
      [2, 9, 10, 11, 12]
    ])
    expect(calls[0]).includes('gray')
    let failed = ''
    try {
      await eachGrayFrame(
        'd.mp4',
        { width: 1, height: 1 },
        () => undefined,
        fakeSpawn(new Uint8Array(0), 1).run
      )
    } catch (error) {
      failed = String(error)
    }
    expect(failed).contains('exit 1')
  })
})

describe('the video layer: first frames and HLS fixtures', function () {
  it('decodes one frame, scaled when asked, and answers null when none comes', async function () {
    const { decodeFirstFrame } = await import('./video')
    const ok = fakeSpawn(Uint8Array.from([7, 8, 9]))
    const frame = await decodeFirstFrame(
      'a.mp4',
      { pixFmt: 'rgb24', width: 1, height: 1 },
      ok.run
    )
    expect([...frame!]).deep.equals([7, 8, 9])
    expect(ok.calls[0]).includes('scale=1:1')
    expect(ok.calls[0]).includes('rgb24')
    const plain = fakeSpawn(Uint8Array.from([1]))
    await decodeFirstFrame('b.mp4', { pixFmt: 'gray' }, plain.run)
    expect(plain.calls[0].join(' ')).not.contains('scale=')
    expect(
      await decodeFirstFrame(
        'c.mp4',
        { pixFmt: 'gray' },
        fakeSpawn(Uint8Array.from([1]), 1).run
      )
    ).equals(null)
    expect(
      await decodeFirstFrame(
        'd.mp4',
        { pixFmt: 'gray' },
        fakeSpawn(new Uint8Array(0)).run
      )
    ).equals(null)
    const failing = ((_command: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough }
      child.stdout = new PassThrough()
      setImmediate(() => child.emit('error', new Error('no ffmpeg')))
      return child
    }) as any
    expect(await decodeFirstFrame('e.mp4', { pixFmt: 'gray' }, failing)).equals(
      null
    )
  })

  it('encodes an event playlist with no end and lists its segments', async function () {
    const { hlsFixture } = await import('./video')
    const dir = scratch()
    try {
      const { run, calls } = fakeRun((_file, args) => {
        writeFileSync(join(dir, 'master1.ts'), '')
        writeFileSync(join(dir, 'master0.ts'), '')
        writeFileSync(args[args.length - 1], '#EXTM3U\n')
        return {}
      })
      const names = hlsFixture(
        dir,
        { seconds: 12, size: '320x180', fps: 10, gop: 20, segmentSeconds: 4 },
        run
      )
      expect(names).deep.equals(['master.m3u8', 'master0.ts', 'master1.ts'])
      const args = calls[0].args.join(' ')
      expect(args).contains('testsrc2=size=320x180:rate=10')
      expect(args).contains('-hls_flags omit_endlist')
      expect(args).contains('-g 20')
      expect(() =>
        hlsFixture(
          dir,
          { seconds: 1, size: '2x2', fps: 1, gop: 1, segmentSeconds: 1 },
          fakeRun(() => ({ status: 1, stderr: 'bad' })).run
        )
      ).throws('bad')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the video layer: pictures compared and read', function () {
  it('compares each picture with the one before it inside a box', async function () {
    const { lumaDiffs } = await import('./video')
    const ok = fakeRun(() => ({
      stdout:
        'frame:0\nlavfi.signalstats.YAVG=0.000\nframe:1\nlavfi.signalstats.YAVG=3.5\nlavfi.signalstats.YAVG=0.25\n'
    }))
    expect(
      lumaDiffs({ pattern: 'd/%06d.png' }, { x: 1.4, y: 2, w: 9, h: 7 }, ok.run)
    ).deep.equals([0, 3.5, 0.25])
    expect(ok.calls[0].args).includes('-framerate')
    expect(ok.calls[0].args.join(' ')).contains('crop=8:6:1:2')
    lumaDiffs({ video: 'v.mp4' }, { x: 0, y: 0, w: 1, h: 1 }, ok.run)
    expect(ok.calls[1].args).not.includes('-framerate')
    expect(ok.calls[1].args.join(' ')).contains('crop=2:2:0:0')
    const bad = fakeRun(() => ({ status: 1, stderr: 'no input' }))
    expect(() =>
      lumaDiffs({ video: 'v.mp4' }, { x: 0, y: 0, w: 4, h: 4 }, bad.run)
    ).throws('no input')
  })

  it('reads digits or white text out of a box, and names a failed tool', async function () {
    const { ocrBox } = await import('./video')
    const box = { x: 10, y: 20, w: 30, h: 40 }
    const ok = fakeRun(file => ({
      stdout: file === 'tesseract' ? ' 0012345\n' : ''
    }))
    expect(ocrBox('a.png', box, 's.png', 'digits', ok.run)).equals('0012345')
    expect(ok.calls[0].args.join(' ')).contains('crop=30:40:10:20')
    expect(ok.calls[0].args.join(' ')).contains('negate')
    expect(ok.calls[1].args).includes('tessedit_char_whitelist=0123456789')
    ocrBox('a.png', box, 's.png', 'white', ok.run)
    expect(ok.calls[2].args.join(' ')).contains('gt(val,235)')
    expect(ok.calls[3].args).not.includes('-c')
    const cut = fakeRun(() => ({ status: 1, stderr: 'bad crop' }))
    expect(() => ocrBox('a.png', box, 's.png', 'digits', cut.run)).throws(
      'bad crop'
    )
    const unread = fakeRun(file =>
      file === 'tesseract' ? { status: 1, stderr: 'no tessdata' } : {}
    )
    expect(() => ocrBox('a.png', box, 's.png', 'white', unread.run)).throws(
      'no tessdata'
    )
  })

  it('cuts a recording into timed numbered pictures', async function () {
    const { stillFrames } = await import('./video')
    const dir = join(scratch(), 'stills')
    const ok = fakeRun((_file, args) => {
      const out = args.at(-1)!
      for (const n of [2, 1, 3])
        writeFileSync(out.replace('%06d', String(n).padStart(6, '0')), 'x')
      writeFileSync(join(dir, 'notes.txt'), 'x')
      return {}
    })
    const stills = stillFrames('r.mp4', dir, 4, ok.run)
    expect(stills.map(one => one.atSec)).deep.equals([0, 0.25, 0.5])
    expect(stills[0].file).equals(join(dir, '000001.png'))
    expect(ok.calls[0].args).includes('fps=4')
    const bad = fakeRun(() => ({ status: 1, stderr: 'broken' }))
    expect(() => stillFrames('r.mp4', dir, 4, bad.run)).throws('broken')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the video layer: a recording’s sound', function () {
  it('says whether a recording has a sound track', async function () {
    const { hasAudio } = await import('./video')
    const loud = fakeRun(() => ({
      stderr: `${DESCRIBED}  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz\n`
    }))
    expect(hasAudio('a.mp4', loud.run)).equals(true)
    expect(loud.calls[0].args).deep.equals(['-hide_banner', '-i', 'a.mp4'])
    expect(
      hasAudio('b.mp4', fakeRun(() => ({ stderr: DESCRIBED })).run)
    ).equals(false)
  })

  it('reads each second’s first momentary loudness and the summary', async function () {
    const { momentaryLoudness } = await import('./video')
    const stderr = [
      '[Parsed_ebur128_0] t: 0.1      TARGET:-23 LUFS    M: -inf S:-120.7',
      '[Parsed_ebur128_0] t: 0.5      TARGET:-23 LUFS    M: -40.2 S:-120.7',
      '[Parsed_ebur128_0] t: 1.2      TARGET:-23 LUFS    M: -31.5 S: -35.0',
      '[Parsed_ebur128_0] Summary:',
      '  Integrated loudness:',
      '    I:         -30.1 LUFS'
    ].join('\n')
    const { run, calls } = fakeRun(() => ({ stderr }))
    const measured = momentaryLoudness('c.mp4', run)
    expect([...measured.seconds]).deep.equals([
      [0, '-inf'],
      [1, '-31.5']
    ])
    expect(measured.summary).matches(/^Summary:[\s\S]*-30\.1 LUFS$/)
    expect(calls[0].args).includes('ebur128')
    const none = momentaryLoudness('d.mp4', fakeRun(() => ({})).run)
    expect(none.seconds.size).equals(0)
    expect(none.summary).equals('')
    const bad = fakeRun(() => ({ status: 1, stderr: 'no audio' })).run
    expect(() => momentaryLoudness('e.mp4', bad)).throws('no audio')
  })

  it('cuts a sound to its first seconds, or keeps the whole of it', async function () {
    const { clipAudio } = await import('./video')
    const { run, calls } = fakeRun(() => ({}))
    clipAudio('whole.mp3', 'cut.mp3', 1.234, run)
    clipAudio('whole.mp3', 'all.mp3', null, run)
    expect(calls[0].args).includes('-t')
    expect(calls[0].args[calls[0].args.indexOf('-t') + 1]).equals('1.23')
    expect(calls[0].args.at(-1)).equals('cut.mp3')
    expect(calls[1].args).not.includes('-t')
    const bad = fakeRun(() => ({ status: 1, stderr: 'no codec' })).run
    expect(() => {
      clipAudio('whole.mp3', 'x.mp3', null, bad)
    }).throws('FFmpeg cut nothing: no codec')
  })

  it('joins sounds through a list it removes, whatever FFmpeg does', async function () {
    const { joinAudio } = await import('./video')
    const dir = scratch()
    try {
      let list = ''
      const { run, calls } = fakeRun((_file, args) => {
        list = readFileSync(args[args.indexOf('-i') + 1], 'utf8')
        return {}
      })
      joinAudio(['/a/1.mp3', '/a/2.mp3'], '/a/all.mp3', dir, run)
      expect(list).equals("file '/a/1.mp3'\nfile '/a/2.mp3'")
      expect(calls[0].args.at(-1)).equals('/a/all.mp3')
      expect(readdirSync(dir)).deep.equals([])
      expect(() => {
        joinAudio([], '/a/none.mp3', dir, run)
      }).throws('No sound to join')
      const bad = fakeRun(() => ({ status: 1, stderr: 'bad list' })).run
      expect(() => {
        joinAudio(['/a/1.mp3'], '/a/x.mp3', dir, bad)
      }).throws('FFmpeg joined nothing: bad list')
      expect(readdirSync(dir)).deep.equals([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
