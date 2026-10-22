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
