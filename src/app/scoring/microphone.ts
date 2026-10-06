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

/**
 * Where the page loads the worklet processor from: `pcm16kWorklet.js`, which
 * `src/build.mjs` copies to the top of `dist/`. A same-origin file, because
 * the page's Content-Security-Policy (`script-src 'self'`) refuses a worklet
 * module built from a `blob:` or `data:` URL.
 */
export const WORKLET_URL = '/pcm16kWorklet.js'

/** What opening the microphone needs from the browser, so a test can supply it. */
export interface MicrophoneDevices {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createContext: () => AudioContext
  createNode: (context: AudioContext) => AudioWorkletNode
  moduleUrl: string
}

const browser: MicrophoneDevices = {
  getUserMedia: async constraints =>
    await navigator.mediaDevices.getUserMedia(constraints),
  createContext: () => new AudioContext(),
  createNode: context => new AudioWorkletNode(context, 'pcm16k'),
  moduleUrl: WORKLET_URL
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
      await context.audioWorklet.addModule(devices.moduleUrl)
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
