import type { ScoringCue } from './scoringAudioTypes'

/** Each cue's length, in seconds. */
export const CUE_SECONDS: Record<ScoringCue, number> = {
  swish: 0.22,
  pop: 0.11,
  bat: 0.06
}

/**
 * A field cue's samples, mono, from -1 to 1: original synthesized effects,
 * with no external sound assets or asset licences. The noise is seeded, so
 * a cue is the same every time, on the web and on a phone.
 */
export function cueSamples(kind: ScoringCue, sampleRate: number): Float32Array {
  const data = new Float32Array(Math.ceil(sampleRate * CUE_SECONDS[kind]))
  let seed = 1347
  let previous = 0
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const noise = seed / 2147483648 - 1
    const t = i / sampleRate
    previous = previous * 0.65 + noise * 0.35
    data[i] =
      kind === 'swish'
        ? previous * Math.sin((Math.PI * i) / data.length) * 0.65
        : kind === 'pop'
          ? (Math.sin(t * 2 * Math.PI * 135) * 0.65 + noise * 0.35) *
            Math.exp(-t * 65)
          : noise * Math.exp(-t * 130) * 0.8
  }
  return data
}

/** The samples as 16-bit integers, for a phone's audio buffers. */
export function int16Of(samples: Float32Array): number[] {
  return Array.from(samples, sample =>
    Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
  )
}
