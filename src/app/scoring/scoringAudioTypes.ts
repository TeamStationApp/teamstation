export type ScoringCue = 'swish' | 'pop' | 'bat'
export interface ScoringAudio {
  /**
   * Readies the cues before the first one is wanted, without a gesture and
   * without starting any sound: the first pitch must not pay for them.
   */
  prepare: () => void
  unlock: () => void
  cue: (kind: ScoringCue) => void
  setEnabled: (enabled: boolean) => void
  stop: () => void
}
