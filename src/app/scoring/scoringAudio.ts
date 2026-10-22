import type { ScoringAudio, ScoringCue } from './scoringAudioTypes'
import { cueSamples } from './scoringCueSamples'
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
  return {
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
        let buffer = buffers.get(kind)
        if (buffer == null) {
          const samples = cueSamples(kind, context.sampleRate)
          buffer = context.createBuffer(1, samples.length, context.sampleRate)
          buffer.getChannelData(0).set(samples)
          buffers.set(kind, buffer)
        }
        const source = context.createBufferSource()
        source.buffer = buffer
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
