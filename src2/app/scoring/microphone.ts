import type { OpenMicrophone } from './dictationTypes'

/**
 * The browser's microphone as 16 kHz mono 16-bit PCM, the format xAI's
 * dictation model takes.
 *
 * The context runs at whatever rate the device does, because Firefox refuses
 * to connect a microphone to a context at another rate; the worklet averages
 * down to 16 kHz itself and posts about a tenth of a second at a time.
 */

export const PCM_RATE = 16000

/** Runs on the audio thread. `sampleRate` is the context's own. */
export const WORKLET_SOURCE = `
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / ${PCM_RATE}
    this.sum = 0
    this.count = 0
    this.step = 0
    this.out = new Int16Array(${PCM_RATE / 10})
    this.length = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel == null) return true
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i]
      this.count++
      this.step++
      if (this.step < this.ratio) continue
      this.step -= this.ratio
      const sample = Math.max(-1, Math.min(1, this.sum / this.count))
      this.out[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      this.sum = 0
      this.count = 0
      if (this.length === this.out.length) {
        const chunk = this.out.slice(0, this.length)
        this.port.postMessage(chunk.buffer, [chunk.buffer])
        this.length = 0
      }
    }
    return true
  }
}
registerProcessor('pcm16k', Pcm16k)
`

/** What opening the microphone needs from the browser, so a test can supply it. */
export interface MicrophoneDevices {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createContext: () => AudioContext
  createNode: (context: AudioContext) => AudioWorkletNode
  moduleUrl: () => string
}

const browser: MicrophoneDevices = {
  getUserMedia: async constraints =>
    await navigator.mediaDevices.getUserMedia(constraints),
  createContext: () => new AudioContext(),
  createNode: context => new AudioWorkletNode(context, 'pcm16k'),
  moduleUrl: () =>
    URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
}

export function makeOpenMicrophone(
  devices: MicrophoneDevices = browser
): OpenMicrophone {
  return async onPcm => {
    const stream = await devices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    const context = devices.createContext()
    try {
      await context.audioWorklet.addModule(devices.moduleUrl())
      const node = devices.createNode(context)
      node.port.onmessage = event => {
        onPcm(event.data as ArrayBuffer)
      }
      context.createMediaStreamSource(stream).connect(node)
      // Silent, since the worklet writes no output; connected so the audio
      // graph pulls the node on every browser.
      node.connect(context.destination)
      if (context.state === 'suspended') await context.resume()
    } catch (error) {
      for (const track of stream.getTracks()) track.stop()
      await context.close().catch(() => undefined)
      throw error
    }
    return {
      stop: () => {
        for (const track of stream.getTracks()) track.stop()
        context.close().catch(() => undefined)
      }
    }
  }
}

export const openMicrophone: OpenMicrophone = makeOpenMicrophone()
