import { expect } from 'chai'
import { describe, it } from 'mocha'

import { readClock } from './clockReader'
import {
  fixtureArgs,
  main,
  parseRenderArgs,
  type Pipe,
  renderFixture
} from './renderFixture'
import { FPS, HEIGHT, renderFrame, WIDTH } from './syntheticFrames'

/** A pipe that holds back now and then, as a busy ffmpeg does. */
function pipe(): Pipe & { chunks: Buffer[]; ended: boolean } {
  const out = {
    chunks: [] as Buffer[],
    ended: false,
    drain: null as (() => void) | null,
    write(data: Buffer): boolean {
      out.chunks.push(Buffer.from(data))
      return out.chunks.length % 7 !== 0
    },
    once(_event: 'drain', listener: () => void) {
      setImmediate(listener)
    },
    end() {
      out.ended = true
    }
  }
  return out
}

function asPicture(frame: Buffer): {
  width: number
  height: number
  data: Uint8Array
} {
  const data = new Uint8Array(WIDTH * HEIGHT * 4)
  for (let i = 0, j = 0; i < frame.length; i += 3, j += 4) {
    data[j] = frame[i]
    data[j + 1] = frame[i + 1]
    data[j + 2] = frame[i + 2]
    data[j + 3] = 255
  }
  return { width: WIDTH, height: HEIGHT, data }
}

describe('a synthetic camera fixture', function () {
  it('burns in the time since its start, which reads back to the millisecond', function () {
    // Away from the white flash that opens every ten seconds.
    for (const index of [10, 1810, 53_999]) {
      const frame = renderFrame({ index, startEpochMs: 0, label: 'SynthA' })
      const reading = readClock(asPicture(frame), {
        x: 0,
        y: 0,
        w: WIDTH,
        h: HEIGHT
      })
      expect(reading?.msOfDay, String(index)).equals(
        Math.round((index * 1000) / FPS)
      )
      expect(reading?.label).equals('SYNTHA')
    }
  })

  it('writes every frame and its sound to ffmpeg, then waits for it', async function () {
    const video = pipe()
    const audio = pipe()
    let args: string[] = []
    const frames = await renderFixture(
      { label: 'SynthB', minutes: 0.01, out: '/f/SynthB.flv', ffmpeg: 'ff' },
      (ffmpeg, given) => {
        expect(ffmpeg).equals('ff')
        args = given
        // As ffmpeg does, it exits once its input has ended.
        const exited = new Promise<number>(resolve => {
          const end = video.end
          video.end = () => {
            end()
            resolve(0)
          }
        })
        return { video, audio, exited }
      }
    )
    expect(frames).equals(18)
    expect(video.chunks).length(18)
    expect(video.chunks[0].length).equals(WIDTH * HEIGHT * 3)
    expect(audio.chunks.reduce((sum, c) => sum + c.length, 0)).equals(
      Math.round((18 * 48_000) / FPS) * 2
    )
    expect(video.ended && audio.ended).equals(true)
    expect(args).deep.equals(fixtureArgs('/f/SynthB.flv'))
    expect(args).includes('libx265')
    expect(args.slice(args.indexOf('-g'), args.indexOf('-g') + 2)).deep.equals([
      '-g',
      '60'
    ])
    expect(args.at(-1)).equals('/f/SynthB.flv')
  })

  it('fails when ffmpeg does', async function () {
    let failure: unknown
    await renderFixture(
      { label: 'SynthC', minutes: 0.001, out: 'x', ffmpeg: 'ff' },
      () => ({ video: pipe(), audio: pipe(), exited: Promise.resolve(1) })
    ).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('ffmpeg exited with 1')
  })

  it('runs as a command, printing what it wrote or why it could not', async function () {
    const said: string[] = []
    const ok = await main(
      [
        '--label',
        'SynthA',
        '--minutes',
        '0.001',
        '--out',
        'o.flv',
        '--ffmpeg',
        'f'
      ],
      line => said.push(line),
      () => ({ video: pipe(), audio: pipe(), exited: Promise.resolve(0) })
    )
    expect(ok).equals(0)
    const failed: string[] = []
    const fails = (line: string): number => failed.push(line)
    expect(
      main(['--label'], line => said.push(line), undefined, fails)
    ).to.be.a('promise')
    expect(
      await main(['--label'], line => said.push(line), undefined, fails)
    ).equals(1)
    // Why it failed goes to stderr, apart from what it wrote.
    expect(said).deep.equals(['o.flv: SynthA, 2 frames'])
    expect(failed).deep.equals([
      'unknown or empty option --label',
      'unknown or empty option --label'
    ])
  })

  it('encodes H.264 with no B-frames when asked, and HEVC unless', async function () {
    const h264 = fixtureArgs('/f/h.flv', 30, 'h264')
    expect(h264).includes('libx264')
    expect(h264).not.includes('libx265')
    expect(
      h264.slice(h264.indexOf('-bf'), h264.indexOf('-bf') + 2)
    ).deep.equals(['-bf', '0'])
    expect(fixtureArgs('/f/h.flv')).deep.equals(
      fixtureArgs('/f/h.flv', 30, 'hevc')
    )
    let args: string[] = []
    await renderFixture(
      {
        label: 'SynthH',
        minutes: 0.001,
        out: '/f/h.flv',
        ffmpeg: 'ff',
        codec: 'h264'
      },
      (ffmpeg, given) => {
        args = given
        return { video: pipe(), audio: pipe(), exited: Promise.resolve(0) }
      }
    )
    expect(args).deep.equals(fixtureArgs('/f/h.flv', FPS, 'h264'))
  })

  it('reads its command line', function () {
    expect(
      parseRenderArgs([
        '--label',
        'SynthD',
        '--minutes',
        '30',
        '--out',
        'o.flv',
        '--ffmpeg',
        'ff'
      ])
    ).deep.equals({ label: 'SynthD', minutes: 30, out: 'o.flv', ffmpeg: 'ff' })
    expect(
      parseRenderArgs([
        '--label',
        'H',
        '--minutes',
        '1',
        '--out',
        'o',
        '--ffmpeg',
        'f',
        '--codec',
        'h264'
      ])
    ).deep.equals({
      label: 'H',
      minutes: 1,
      out: 'o',
      ffmpeg: 'f',
      codec: 'h264'
    })
    expect(() =>
      parseRenderArgs([
        '--label',
        'H',
        '--minutes',
        '1',
        '--out',
        'o',
        '--ffmpeg',
        'f',
        '--codec',
        'vp9'
      ])
    ).throws('--codec is hevc or h264')
    expect(() => parseRenderArgs(['--label'])).throws('unknown or empty')
    expect(() => parseRenderArgs(['--label', 'x'])).throws(
      '--minutes is needed'
    )
    expect(() =>
      parseRenderArgs([
        '--label',
        'x',
        '--minutes',
        '0',
        '--out',
        'o',
        '--ffmpeg',
        'f'
      ])
    ).throws('positive number')
  })
})
