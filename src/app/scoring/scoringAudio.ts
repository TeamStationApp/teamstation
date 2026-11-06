import type { ScoringAudio, ScoringCue } from './scoringAudioTypes'
import { cueSamples } from './scoringCueSamples'

const CUES: ScoringCue[] = ['swish', 'pop', 'bat']
/** The field cues in the browser, from the shared samples. */
export function makeScoringAudio(
  createContext: () => AudioContext = () => new AudioContext()
): ScoringAudio {
  let context: AudioContext | undefined
  let enabled = true
  const voices = new Set<AudioBufferSourceNode>()
  const buffers = new Map<ScoringCue, AudioBuffer>()
  const stop = (): void => {
    for (const voice of voices) {
      try {
        voice.stop()
        voice.disconnect()
      } catch {
        /* Already ended. */
      }
    }
    voices.clear()
  }
  const bufferOf = (kind: ScoringCue, audio: AudioContext): AudioBuffer => {
    let buffer = buffers.get(kind)
    if (buffer == null) {
      const samples = cueSamples(kind, audio.sampleRate)
      buffer = audio.createBuffer(1, samples.length, audio.sampleRate)
      buffer.getChannelData(0).set(samples)
      buffers.set(kind, buffer)
    }
    return buffer
  }
  return {
    // A context made without a gesture stays suspended until `unlock`.
    prepare() {
      try {
        context ??= createContext()
        for (const kind of CUES) bufferOf(kind, context)
      } catch {
        /* Made on the gesture instead. */
      }
    },
    unlock() {
      try {
        context ??= createContext()
        if (context.state === 'suspended')
          context.resume().catch(() => undefined)
      } catch {
        /* Retry on a later user gesture. */
      }
    },
    setEnabled(value) {
      enabled = value
      if (!value) stop()
    },
    stop,
    cue(kind) {
      if (!enabled || context?.state !== 'running') return
      try {
        if (voices.size >= 4) stop()
        const source = context.createBufferSource()
        source.buffer = bufferOf(kind, context)
        source.connect(context.destination)
        voices.add(source)
        source.onended = () => {
          voices.delete(source)
          source.disconnect()
        }
        source.start()
      } catch {
        /* Sound failure never blocks scoring. */
      }
    }
  }
}
export const scoringAudio = makeScoringAudio()
