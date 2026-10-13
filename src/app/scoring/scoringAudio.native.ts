import walkUpMusic from '../walkup/walkUpMusic'
import {
  makeNativeScoringAudio,
  otherAudioSounding,
  setOtherAudio
} from './cueSoundsController'
import NativeCueSounds from './NativeCueSounds'

/** The field cues on a phone, through the `CueSounds` native module. */
walkUpMusic.onState(state => {
  setOtherAudio('walkUp', state.kind === 'playing')
})
export const scoringAudio = makeNativeScoringAudio(
  NativeCueSounds ?? null,
  otherAudioSounding
)
