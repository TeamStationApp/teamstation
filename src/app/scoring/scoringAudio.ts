import type { ScoringAudio, ScoringCue } from './scoringAudioTypes'
/** Original synthesized effects. No external sound assets or asset licences. */
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
          const duration =
            kind === 'swish' ? 0.22 : kind === 'pop' ? 0.11 : 0.06
          buffer = context.createBuffer(
            1,
            Math.ceil(context.sampleRate * duration),
            context.sampleRate
          )
          const data = buffer.getChannelData(0)
          let seed = 1347
          let previous = 0
          for (let i = 0; i < data.length; i++) {
            seed = (seed * 1664525 + 1013904223) >>> 0
            const noise = seed / 2147483648 - 1
            const t = i / context.sampleRate
            previous = previous * 0.65 + noise * 0.35
            data[i] =
              kind === 'swish'
                ? previous * Math.sin((Math.PI * i) / data.length) * 0.65
                : kind === 'pop'
                  ? (Math.sin(t * 2 * Math.PI * 135) * 0.65 + noise * 0.35) *
                    Math.exp(-t * 65)
                  : noise * Math.exp(-t * 130) * 0.8
          }
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
