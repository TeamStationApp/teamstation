import assert from 'node:assert/strict'
import { execFileSync, type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { after, before, describe, it } from 'mocha'

import {
  calibrateCamera,
  cameraLatencyMs,
  captureStep,
  frameTimes,
  grayFrame,
  recordWebcam,
  screensFromCalibration
} from './webcam'

/** A `width × height` grid, dark, with bright rectangles. */
function grid(
  width: number,
  height: number,
  lit: Array<[number, number, number, number]>
): Uint8Array {
  const cells = new Uint8Array(width * height).fill(20)
  for (const [x, y, w, h] of lit) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) cells[row * width + col] = 230
    }
  }
  return cells
}

describe('playback probe: webcam', function () {
  this.timeout(60000)
  let dir: string

  before(function () {
    dir = mkdtempSync(join(tmpdir(), 'pbr-webcam-'))
  })

  after(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds three screens, left to right, in source pixels', function () {
    const width = 100
    const height = 50
    const white = grid(width, height, [
      [60, 10, 10, 20],
      [10, 5, 12, 30],
      [35, 8, 11, 25],
      [90, 1, 1, 1]
    ])
    const black = grid(width, height, [])
    const screens = screensFromCalibration(white, black, width, height, 2000)
    assert.deepEqual(screens, [
      { x: 200, y: 100, w: 240, h: 600 },
      { x: 700, y: 160, w: 220, h: 500 },
      { x: 1200, y: 200, w: 200, h: 400 }
    ])
  })

  it('does not join a screen across the edge of the frame', function () {
    const white = grid(10, 4, [
      [9, 0, 1, 4],
      [0, 1, 1, 3]
    ])
    const screens = screensFromCalibration(white, grid(10, 4, []), 10, 4, 10, {
      minCells: 3
    })
    assert.equal(screens.length, 2)
  })

  it('reads a frame as luma and lists frame times', async function () {
    const video = join(dir, 'clip.mp4')
    execFileSync('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=white:size=64x32:rate=10',
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-y',
      video
    ])
    const frame = await grayFrame(video, 0.5, 16, 8)
    assert.equal(frame.length, 128)
    assert.ok(frame.every(value => value > 200))
    const times = await frameTimes(video)
    assert.equal(times.length, 10)
    assert.deepEqual(times.slice(0, 3), [0, 100, 200])
  })

  it('records until stopped, and stops ffmpeg with q so the file is whole', async function () {
    const calls: Array<{ program: string; args: string[] }> = []
    let written = ''
    const fake = ((program: string, args: string[]) => {
      calls.push({ program, args })
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough }
      child.stdin = new PassThrough()
      child.stdin.on('data', chunk => {
        written += String(chunk)
      })
      child.stdin.on('finish', () => {
        child.emit('exit', 0)
      })
      return child
    }) as unknown as typeof spawn
    const recording = recordWebcam(
      'rtsps://camera.example.test/stream',
      join(dir, 'bench.mp4'),
      30,
      'ffmpeg',
      fake
    )
    assert.equal(recording.file, join(dir, 'bench.mp4'))
    await recording.stop()
    assert.equal(written, 'q')
    // ffmpeg must still read its stdin, or the `q` is ignored and stop() waits for ever.
    assert.ok(!calls[0].args.includes('-nostdin'))
    assert.equal(calls[0].program, 'ffmpeg')
    assert.deepEqual(calls[0].args.slice(-7), [
      'rtsps://camera.example.test/stream',
      '-t',
      '30',
      '-c',
      'copy',
      '-y',
      join(dir, 'bench.mp4')
    ])
  })

  it('interrupts a recorder that ignores q', async function () {
    this.timeout(15000)
    const signals: string[] = []
    const deaf = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        kill: (signal: string) => void
      }
      child.stdin = new PassThrough()
      child.kill = signal => {
        signals.push(signal)
        child.emit('exit', null)
      }
      return child
    }) as unknown as typeof spawn
    const recording = recordWebcam(
      'rtsps://camera.example.test/stream',
      join(dir, 'deaf.mp4'),
      30,
      'ffmpeg',
      deaf
    )
    await recording.stop()
    assert.deepEqual(signals, ['SIGINT'])
  })

  it("films a step, timing each frame from where the first arrived, less the camera's delay", async function () {
    const out = join(dir, 'step')
    let stderr: PassThrough | undefined
    let args: string[] = []
    const fake = ((_program: string, given: string[]) => {
      args = given
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stderr: PassThrough
      }
      child.stdin = new PassThrough()
      child.stderr = new PassThrough()
      stderr = child.stderr
      child.stdin.on('finish', () => {
        child.emit('exit', 0)
      })
      return child
    }) as unknown as typeof spawn
    let clock = 10_000
    const capture = captureStep(
      'rtsps://camera.example.test/stream',
      { x: 10.4, y: 20, w: 300, h: 500 },
      out,
      12,
      900,
      8,
      'ffmpeg',
      fake,
      () => clock
    )
    assert.ok(args.includes('crop=300:500:10:20,fps=8,showinfo'))
    // Three frames reported, a line split across two writes; four written.
    stderr!.write(
      '[Parsed_showinfo_2 @ 0x1] n:   0 pts:  1 pts_time:5.0   \n[Parsed_showinfo_2 @ 0x1] n:   1 pts:  2 pts_'
    )
    clock = 10_500
    stderr!.write(
      'time:5.125\n[Parsed_showinfo_2 @ 0x1] n: 2 pts: 3 pts_time:5.25\nnoise\n'
    )
    for (const name of [
      '000001.png',
      '000002.png',
      '000003.png',
      '000004.png',
      'other.txt'
    ]) {
      writeFileSync(join(out, name), '')
    }
    await capture.stop()
    const frames = await capture.frames()
    assert.deepEqual(
      frames.map(frame => frame.atMs),
      [9100, 9225, 9350, 9475]
    )
    assert.equal(frames[3].file, join(out, '000004.png'))
  })

  it('reads how late the camera shows the glass turning light', function () {
    const frames = [0, 100, 200, 300, 400, 500, 600].map((atMs, index) => ({
      atMs,
      luma: index < 5 ? 20 : 200
    }))
    assert.equal(cameraLatencyMs(frames, 150), 350)
    // Never brightened, or nothing before the flash to compare with.
    assert.equal(
      cameraLatencyMs(
        frames.map(frame => ({ ...frame, luma: 20 })),
        150
      ),
      null
    )
    assert.equal(cameraLatencyMs(frames, -1), null)
  })

  it('finds the glass and the delay from a black and a white screen', async function () {
    let clock = 0
    const shown: Array<string | null> = []
    const frames = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000].map(
      (atMs, index) => ({ atMs, file: `frame-${index}` })
    )
    // A 40×30 picture: the glass at cells 10–19 × 5–24, light from 5000 ms.
    const grid = (light: boolean): Uint8Array => {
      const cells = new Uint8Array(40 * 30).fill(30)
      if (light) {
        for (let y = 5; y < 25; y++)
          for (let x = 10; x < 20; x++) cells[y * 40 + x] = 240
      }
      return cells
    }
    const result = await calibrateCamera(
      'rtsps://camera.example.test/stream',
      join(dir, 'calibrate'),
      async color => {
        shown.push(color)
      },
      {
        sourceWidth: 400,
        sourceHeight: 300,
        width: 40,
        pause: async ms => {
          clock += ms
        },
        now: () => clock,
        capture: () => ({
          stop: async () => undefined,
          frames: async () => frames
        }),
        frame: async file => grid(Number(file.slice(6)) >= 5)
      }
    )
    assert.deepEqual(shown, ['black', 'white', null])
    assert.deepEqual(result.box, { x: 100, y: 50, w: 100, h: 200 })
    // White at 3500 ms; first light frame at 5000 ms.
    assert.equal(result.latencyMs, 1500)
  })
})
