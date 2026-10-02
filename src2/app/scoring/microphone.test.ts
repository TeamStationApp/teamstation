import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  makeOpenMicrophone,
  type MicrophoneDevices,
  PCM_RATE,
  WORKLET_SOURCE
} from './microphone'

/** Runs the worklet's source against a stand-in for the audio thread. */
function processor(sampleRate: number): {
  process: (samples: number[]) => void
  silence: () => void
  posted: Int16Array[]
} {
  const posted: Int16Array[] = []
  let made: { process: (inputs: Float32Array[][]) => boolean } | undefined
  class AudioWorkletProcessor {
    port = {
      postMessage: (buffer: ArrayBuffer) => {
        posted.push(new Int16Array(buffer))
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    WORKLET_SOURCE
  )(
    AudioWorkletProcessor,
    (name: string, Kind: new () => typeof made) => {
      expect(name).equals('pcm16k')
      made = new Kind()
    },
    sampleRate
  )
  return {
    posted,
    silence: () => {
      expect(made!.process([[]])).equals(true)
      expect(made!.process([])).equals(true)
    },
    process: samples => {
      expect(made!.process([[Float32Array.from(samples)]])).equals(true)
    }
  }
}

describe('the microphone', function () {
  it('averages 48 kHz down to 16 kHz and posts a tenth of a second at a time', function () {
    const worklet = processor(48000)
    // Three input samples make one output sample.
    const second = Array.from({ length: 4800 }, (_, i) =>
      i % 3 === 0 ? 0.3 : 0
    )
    worklet.process(second)
    expect(worklet.posted).to.have.length(1)
    expect(worklet.posted[0].length).equals(PCM_RATE / 10)
    expect(worklet.posted[0][0]).equals(Math.trunc(0.1 * 0x7fff))
    worklet.process(Array.from({ length: 3 }, () => -2))
    worklet.process(Array.from({ length: 4797 }, () => 0))
    expect(worklet.posted).to.have.length(2)
    // Clipped, and negative samples scale to -32768.
    expect(worklet.posted[1][0]).equals(-0x8000)
  })

  it('passes 16 kHz through one sample at a time, and skips an empty input', function () {
    const worklet = processor(16000)
    worklet.process(Array.from({ length: 1600 }, () => 1))
    expect(worklet.posted[0].every(sample => sample === 0x7fff)).equals(true)
    const empty = processor(16000)
    // An input with no channel yet, as at the start of a stream.
    empty.silence()
    expect(empty.posted).deep.equals([])
  })

  it('opens the device, connects it through the worklet, and stops it', async function () {
    const calls: string[] = []
    const port: { onmessage?: (event: { data: unknown }) => void } = {}
    const track = { stop: () => calls.push('track stopped') }
    const context = {
      state: 'suspended',
      destination: 'speakers',
      audioWorklet: {
        addModule: async (url: string) => {
          calls.push(`module ${url}`)
        }
      },
      createMediaStreamSource: () => ({
        connect: () => calls.push('source → worklet')
      }),
      resume: async () => {
        calls.push('resumed')
      },
      close: async () => {
        calls.push('closed')
      }
    }
    const devices = {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        calls.push(`asked ${JSON.stringify(constraints.audio)}`)
        return { getTracks: () => [track] }
      },
      createContext: () => context,
      createNode: () => ({
        port,
        connect: (to: unknown) => calls.push(`worklet → ${String(to)}`)
      }),
      moduleUrl: () => 'blob:pcm'
    } as unknown as MicrophoneDevices
    const chunks: ArrayBuffer[] = []
    const microphone = await makeOpenMicrophone(devices)(pcm =>
      chunks.push(pcm)
    )
    expect(calls).deep.equals([
      'asked {"channelCount":1,"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true}',
      'module blob:pcm',
      'source → worklet',
      'worklet → speakers',
      'resumed'
    ])
    const chunk = new ArrayBuffer(4)
    port.onmessage!({ data: chunk })
    expect(chunks).deep.equals([chunk])
    microphone.stop()
    expect(calls.slice(-2)).deep.equals(['track stopped', 'closed'])
  })

  it('releases the device when the worklet cannot load', async function () {
    const calls: string[] = []
    const devices = {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => calls.push('track stopped') }]
      }),
      createContext: () => ({
        audioWorklet: {
          addModule: async () => {
            throw new Error('blocked')
          }
        },
        close: async () => {
          calls.push('closed')
        }
      }),
      createNode: () => {
        throw new Error('unreachable')
      },
      moduleUrl: () => 'blob:pcm'
    } as unknown as MicrophoneDevices
    let failure: unknown
    try {
      await makeOpenMicrophone(devices)(() => undefined)
    } catch (error) {
      failure = error
    }
    expect((failure as Error).message).equals('blocked')
    expect(calls).deep.equals(['track stopped', 'closed'])
  })
})
