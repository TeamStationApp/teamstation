import { expect } from 'chai'
import { describe, it } from 'mocha'

import { makeScoringAudio } from './scoringAudio'
describe('synthesized scoring sound', function () {
  it('unlocks on a gesture, bounds voices, honors mute, and cancels outstanding sources', async function () {
    let created = 0
    let started = 0
    let stopped = 0
    let resumed = 0
    let disconnected = 0
    const sources: Array<{ onended?: () => void }> = []
    const context = {
      state: 'suspended',
      sampleRate: 8000,
      destination: {},
      resume: async () => {
        resumed++
        context.state = 'running'
      },
      createBuffer: (_channels: number, length: number) => {
        const samples = new Float32Array(length)
        return { getChannelData: () => samples }
      },
      createBufferSource: () => {
        const source = {
          onended: undefined as (() => void) | undefined,
          connect() {},
          disconnect() {
            disconnected++
          },
          start() {
            started++
          },
          stop() {
            stopped++
          },
          buffer: null
        }
        sources.push(source)
        return source
      }
    }
    const audio = makeScoringAudio(() => {
      created++
      return context as unknown as AudioContext
    })
    audio.cue('pop')
    expect(started).equals(0)
    audio.unlock()
    await Promise.resolve()
    expect(created).equals(1)
    expect(resumed).equals(1)
    for (const cue of ['swish', 'pop', 'bat', 'pop', 'swish'] as const)
      audio.cue(cue)
    expect(started).equals(5)
    expect(stopped).equals(4)
    sources.at(-1)?.onended?.()
    expect(disconnected).equals(5)
    audio.setEnabled(false)
    audio.cue('pop')
    expect(started).equals(5)
    audio.setEnabled(true)
    audio.unlock()
    audio.cue('pop')
    audio.stop()
    expect(stopped).equals(5)
  })
  it('makes the context and every cue before the first gesture, and resumes it only on one', async function () {
    let created = 0
    let buffers = 0
    let resumed = 0
    let started = 0
    const context = {
      state: 'suspended',
      sampleRate: 8000,
      destination: {},
      resume: async () => {
        resumed++
        context.state = 'running'
      },
      createBuffer: (_channels: number, length: number) => {
        buffers++
        const samples = new Float32Array(length)
        return { getChannelData: () => samples }
      },
      createBufferSource: () => ({
        connect() {},
        disconnect() {},
        start() {
          started++
        },
        stop() {},
        buffer: null
      })
    }
    const audio = makeScoringAudio(() => {
      created++
      return context as unknown as AudioContext
    })
    audio.prepare()
    audio.prepare()
    expect([created, buffers, resumed]).deep.equals([1, 3, 0])
    audio.cue('pop')
    expect(started).equals(0)
    audio.unlock()
    await Promise.resolve()
    audio.cue('pop')
    audio.cue('bat')
    expect([created, buffers, resumed, started]).deep.equals([1, 3, 1, 2])
    const failing = makeScoringAudio(() => {
      throw new Error('No device')
    })
    expect(() => {
      failing.prepare()
    }).not.throws()
  })
  it('contains unlock and playback failures without affecting scoring', function () {
    let attempts = 0
    const audio = makeScoringAudio(() => {
      attempts++
      throw new Error('No device')
    })
    audio.unlock()
    audio.unlock()
    audio.cue('swish')
    expect(attempts).equals(2)
    const broken = makeScoringAudio(
      () =>
        ({
          state: 'running',
          createBuffer() {
            throw new Error('Lost context')
          }
        }) as unknown as AudioContext
    )
    broken.unlock()
    expect(() => {
      broken.cue('bat')
    }).not.throws()
  })
})
