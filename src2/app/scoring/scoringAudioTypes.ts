export type ScoringCue = 'swish' | 'pop' | 'bat'
export interface ScoringAudio {
  unlock: () => void
  cue: (kind: ScoringCue) => void
  setEnabled: (enabled: boolean) => void
  stop: () => void
}
