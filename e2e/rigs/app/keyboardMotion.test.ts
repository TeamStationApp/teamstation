import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  fieldTopPerFrame,
  type Frame,
  frames,
  motionFile,
  motionOf,
  parseCrop,
  record,
  splitFrames,
  webcamFor
} from './keyboardMotion'

/** A frame dark above `edge` and light from it down, with a little noise. */
function frame(edge: number, noise = 0, width = 20, height = 200): Frame {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data[y * width + x] =
        (y < edge ? 40 : 220) + (noise === 0 ? 0 : (x * 7 + y * 13) % noise)
  return { width, height, data }
}

/** A stand-in for ffmpeg: what it was asked, and what it prints. */
function fakeSpawn(
  stdout?: Uint8Array,
  code = 0
): { run: any; calls: Array<{ args: string[]; signals: string[] }> } {
  const calls: Array<{ args: string[]; signals: string[] }> = []
  const run = ((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: (signal: string) => void
    }
    const call = { args, signals: [] as string[] }
    calls.push(call)
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = signal => {
      call.signals.push(signal)
      setImmediate(() => child.emit('close', 0))
    }
    if (stdout != null)
      setImmediate(() => {
        child.stdout.end(stdout)
        setImmediate(() => child.emit('close', code))
      })
    return child
  }) as any
  return { run, calls }
}

describe('keyboard motion on the bench camera', function () {
  it('reads a crop with the field’s place at rest, and refuses anything else', function () {
    expect(parseCrop('540:1170:1200:300:1000')).deep.equals({
      width: 540,
      height: 1170,
      x: 1200,
      y: 300,
      fieldY: 1000
    })
    expect(parseCrop('440:260:620:80:120:ccw')).deep.equals({
      width: 440,
      height: 260,
      x: 620,
      y: 80,
      fieldY: 120,
      turn: 'ccw'
    })
    expect(() => parseCrop('540:1170:1200:300')).throws('w:h:x:y:fieldY')
    expect(() => parseCrop('a:b:c:d:e')).throws()
  })

  it('finds the camera and a device’s crop, or nothing when either is missing', function () {
    const webcam = {
      url: 'rtsps://camera/x',
      crops: { 'p@hub': '10:20:30:40:15' }
    }
    expect(webcamFor('p@hub', { webcam })).deep.equals({
      url: 'rtsps://camera/x',
      crop: { width: 10, height: 20, x: 30, y: 40, fieldY: 15 }
    })
    expect(webcamFor('q@hub', { webcam })).equals(null)
    expect(webcamFor('p@hub', {})).equals(null)
  })

  it('follows the edge down the centre column, frame to frame', function () {
    const edges = [150, 150, 140, 120, 100, 90, 90]
    expect(
      fieldTopPerFrame(
        edges.map(e => frame(e)),
        150
      )
    ).deep.equals(edges)
    // Webcam shimmer does not move it.
    expect(
      fieldTopPerFrame(
        edges.map(e => frame(e, 9)),
        150
      )
    ).deep.equals(edges)
  })

  it('keeps up with a fast keyboard on a tall crop', function () {
    // 1500 rows tall: 120 rows a frame, more than a fixed 60 could follow.
    const edges = [1300, 1300, 1180, 1060, 940, 820, 760, 760]
    expect(
      fieldTopPerFrame(
        edges.map(e => frame(e, 0, 20, 1500)),
        1300
      )
    ).deep.equals(edges)
  })

  it('calls a ramp up and back animated, and a jump not', function () {
    const ramp = [150, 150, 140, 125, 110, 95, 90, 90, 100, 115, 130, 145, 150]
    const animated = motionOf(ramp)
    expect(animated.up.animated).equals(true)
    expect(animated.down.animated).equals(true)
    expect(animated.up.between).deep.equals([140, 125, 110, 95])
    const snap = motionOf([150, 150, 90, 90, 90, 150, 150])
    expect(snap.up.animated).equals(false)
    expect(snap.down.animated).equals(false)
    // Up animated, down snapped: each way is judged on its own.
    const half = motionOf([150, 140, 125, 110, 90, 90, 150])
    expect([half.up.animated, half.down.animated]).deep.equals([true, false])
    expect(() => motionOf([])).throws('no frames')
  })

  it('records the camera around the action, and ends ffmpeg with an interrupt', async function () {
    const { run, calls } = fakeSpawn()
    const order: string[] = []
    const file = await record(
      'rtsps://camera/x',
      '/run/motion.mp4',
      async () => {
        order.push(`action after ${calls.length} recorder`)
      },
      { leadMs: 1, tailMs: 1, run }
    )
    expect(file).equals('/run/motion.mp4')
    expect(order).deep.equals(['action after 1 recorder'])
    expect(calls[0].args).includes('rtsps://camera/x')
    expect(calls[0].args.slice(-2)).deep.equals(['-y', '/run/motion.mp4'])
    expect(calls[0].signals).deep.equals(['SIGINT'])
  })

  it('fails at once, with ffmpeg’s reason, when the recording cannot start or stops', async function () {
    const acted: string[] = []
    const missing = ((): any => {
      const child = new EventEmitter() as any
      child.stderr = new PassThrough()
      child.kill = () => undefined
      setImmediate(() => child.emit('error', new Error('spawn ffmpeg ENOENT')))
      return child
    }) as any
    let error: unknown
    try {
      await record(
        'rtsps://camera/x',
        '/run/m.mp4',
        async () => {
          acted.push('acted')
        },
        { leadMs: 50, tailMs: 1, run: missing }
      )
    } catch (caught) {
      error = caught
    }
    expect(String(error)).includes('ENOENT')
    expect(acted, 'no action without a recording').deep.equals([])

    const refused = ((): any => {
      const child = new EventEmitter() as any
      child.stderr = new PassThrough()
      child.kill = () => undefined
      setImmediate(() => {
        child.stderr.write('401 Unauthorized')
        setImmediate(() => child.emit('close', 1))
      })
      return child
    }) as any
    error = undefined
    try {
      await record('rtsps://camera/x', '/run/m.mp4', async () => undefined, {
        leadMs: 50,
        tailMs: 1,
        run: refused
      })
    } catch (caught) {
      error = caught
    }
    expect(String(error)).includes('401 Unauthorized')
  })

  it('reads a recording back as cropped grayscale frames', async function () {
    const crop = { width: 4, height: 2, x: 1, y: 2, fieldY: 1 }
    const raw = new Uint8Array(4 * 2 * 3 + 5).fill(9)
    const { run, calls } = fakeSpawn(raw)
    const read = await frames('/run/motion.mp4', crop, run)
    expect(read).length(3)
    expect(read[0].data).length(8)
    expect(calls[0].args).includes(
      'crop=4:2:1:2,crop=4:ih:(iw-4)/2:0,format=gray'
    )
    const failing = fakeSpawn(new Uint8Array(0), 1)
    let error: unknown
    try {
      await frames('/run/bad.mp4', crop, failing.run)
    } catch (caught) {
      error = caught
    }
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
    expect(turned.calls[0].args).includes(
      'crop=4:2:1:2,transpose=1,crop=2:ih:(iw-2)/2:0,format=gray'
    )
    expect(splitFrames(new Uint8Array(7), 2, 2)).length(1)
    expect(motionFile('/run', 'open')).equals('/run/open.mp4')
  })
})
