import type { ScoringAudio, ScoringCue } from './scoringAudioTypes'
import { cueSamples, int16Of } from './scoringCueSamples'

/**
 * The field cues on a phone. The native module only passes calls through;
 * every choice is made here, where a test can reach it: when to load, which
 * voice plays next, the audio session to ask for, restarting an engine an
 * interruption stopped, and swallowing every failure so sound never gets in
 * the way of scoring.
 */

export interface CueSoundsModule {
  load: (kind: string, samples: readonly number[], sampleRate: number) => void
  play: (kind: string, voice: number) => void
  stop: () => void
  isRunning: () => boolean
  start: () => void
  sessionCategory: () => string
  useAmbientSession: () => void
}

export const SAMPLE_RATE = 44100
export const VOICES = 4
const CUES: ScoringCue[] = ['swish', 'pop', 'bat']
const PLAY_AND_RECORD = 'AVAudioSessionCategoryPlayAndRecord'
const AMBIENT = 'AVAudioSessionCategoryAmbient'

export function makeNativeScoringAudio(
  module: CueSoundsModule | null,
  otherAudioActive: () => boolean = () => false,
  samples = cueSamples
): ScoringAudio {
  let enabled = true
  let loaded = false
  let voice = 0
  const attempt = (step: (native: CueSoundsModule) => void): void => {
    if (module == null) return
    try {
      step(module)
    } catch {
      /* Sound failure never blocks scoring. */
    }
  }
  /**
   * Ambient, mixing with whatever else plays, unless dictation holds the
   * microphone or another of the app's players is sounding. Read every time:
   * a video or the announcer can leave the session in playback after it.
   */
  const ensureSession = (native: CueSoundsModule): void => {
    const category = native.sessionCategory()
    if (category === '' || category === PLAY_AND_RECORD) return
    if (otherAudioActive()) return
    if (category !== AMBIENT) native.useAmbientSession()
  }
  const ready = (native: CueSoundsModule): void => {
    ensureSession(native)
    if (!loaded) {
      for (const kind of CUES)
        native.load(kind, int16Of(samples(kind, SAMPLE_RATE)), SAMPLE_RATE)
      loaded = true
    }
    if (!native.isRunning()) native.start()
  }
  return {
    unlock() {
      attempt(ready)
    },
    setEnabled(value) {
      enabled = value
      if (!value)
        attempt(native => {
          native.stop()
        })
    },
    stop() {
      attempt(native => {
        native.stop()
      })
    },
    cue(kind) {
      if (!enabled) return
      attempt(native => {
        ready(native)
        native.play(kind, voice)
        voice = (voice + 1) % VOICES
      })
    }
  }
}

/** The app's players that sound on a phone, which the cues must not cut off. */
const sounding = new Set<string>()

/** Says whether one of the app's players is sounding now. */
export function setOtherAudio(source: string, active: boolean): void {
  if (active) sounding.add(source)
  else sounding.delete(source)
}

export function otherAudioSounding(): boolean {
  return sounding.size > 0
}
