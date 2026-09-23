import type { ScoringAudio } from './scoringAudioTypes'
/** Native field rendering is not installed yet; the browser owns sound playback. */
export const scoringAudio: ScoringAudio = {
  unlock() {},
  cue() {},
  setEnabled() {},
  stop() {}
}
