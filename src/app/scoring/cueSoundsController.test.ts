import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type CueSoundsModule,
  makeNativeScoringAudio,
  otherAudioSounding,
  SAMPLE_RATE,
  setOtherAudio
} from './cueSoundsController'
import { cueSamples, int16Of } from './scoringCueSamples'

/** The native module in memory: every call, and a session to play with. */
class FakeCueSounds implements CueSoundsModule {
  calls: string[] = []
  loaded: Record<string, { samples: readonly number[]; rate: number }> = {}
  category = 'AVAudioSessionCategorySoloAmbient'
  running = false
  throwing = false

  private call(name: string): void {
    this.calls.push(name)
    if (this.throwing) throw new Error('Native failure')
  }

  load(kind: string, samples: readonly number[], sampleRate: number): void {
    this.call(`load ${kind}`)
    this.loaded[kind] = { samples, rate: sampleRate }
  }

  play(kind: string, voice: number): void {
    this.call(`play ${kind} ${voice}`)
  }

  stop(): void {
    this.call('stop')
  }

  isRunning(): boolean {
    this.call('isRunning')
    return this.running
  }

  start(): void {
    this.call('start')
    this.running = true
  }

  sessionCategory(): string {
    this.call('sessionCategory')
    return this.category
  }

  useAmbientSession(): void {
    this.call('useAmbientSession')
    this.category = 'AVAudioSessionCategoryAmbient'
  }
}

describe('field cues on a phone', function () {
  it('is silent with no native module', function () {
    const audio = makeNativeScoringAudio(null)
    expect(() => {
      audio.unlock()
      audio.cue('pop')
      audio.setEnabled(false)
      audio.stop()
    }).not.throws()
  })

  it('asks for an ambient session, loads every cue once and starts the engine on the first unlock', function () {
    const native = new FakeCueSounds()
    const audio = makeNativeScoringAudio(native)
    audio.unlock()
    expect(native.calls).deep.equals([
      'sessionCategory',
      'useAmbientSession',
      'load swish',
      'load pop',
      'load bat',
      'isRunning',
      'start'
    ])
    expect(native.loaded.pop).deep.equals({
      samples: int16Of(cueSamples('pop', SAMPLE_RATE)),
      rate: SAMPLE_RATE
    })
    native.calls = []
    audio.unlock()
    expect(native.calls).deep.equals(['sessionCategory', 'isRunning'])
  })

  it('plays each cue on the next of four voices, and nothing while disabled', function () {
    const native = new FakeCueSounds()
    const audio = makeNativeScoringAudio(native)
    for (const kind of ['swish', 'pop', 'bat', 'swish', 'pop'] as const)
      audio.cue(kind)
    expect(native.calls.filter(call => call.startsWith('play'))).deep.equals([
      'play swish 0',
      'play pop 1',
      'play bat 2',
      'play swish 3',
      'play pop 0'
    ])
    native.calls = []
    // Muting the game stops the cues only: a walk-up song sounding stays so.
    setOtherAudio('walkUp', true)
    audio.setEnabled(false)
    expect(otherAudioSounding()).equals(true)
    setOtherAudio('walkUp', false)
    audio.cue('bat')
    expect(native.calls).deep.equals(['stop'])
    audio.setEnabled(true)
    audio.cue('bat')
    expect(native.calls.at(-1)).equals('play bat 1')
    audio.stop()
    expect(native.calls.at(-1)).equals('stop')
  })

  it('restarts an engine an interruption stopped before the next cue', function () {
    const native = new FakeCueSounds()
    const audio = makeNativeScoringAudio(native)
    audio.unlock()
    native.running = false
    native.calls = []
    audio.cue('pop')
    expect(native.calls).deep.equals([
      'sessionCategory',
      'isRunning',
      'start',
      'play pop 0'
    ])
  })

  it('takes the session back to ambient after a video or the announcer, unless another player is sounding', function () {
    const native = new FakeCueSounds()
    let walkUpPlaying = false
    const audio = makeNativeScoringAudio(native, () => walkUpPlaying)
    audio.unlock()
    native.category = 'AVAudioSessionCategoryPlayback'
    native.calls = []
    audio.cue('pop')
    expect(native.calls).includes('useAmbientSession')
    native.category = 'AVAudioSessionCategoryPlayback'
    walkUpPlaying = true
    native.calls = []
    audio.cue('pop')
    expect(native.calls).not.includes('useAmbientSession')
    expect(native.category).equals('AVAudioSessionCategoryPlayback')
  })

  it('leaves dictation’s session and Android’s alone', function () {
    for (const category of ['AVAudioSessionCategoryPlayAndRecord', '']) {
      const native = new FakeCueSounds()
      native.category = category
      makeNativeScoringAudio(native).cue('bat')
      expect(native.calls).not.includes('useAmbientSession')
      expect(native.calls).includes('play bat 0')
    }
  })

  it('never throws when the native module does', function () {
    const native = new FakeCueSounds()
    native.throwing = true
    const audio = makeNativeScoringAudio(native)
    expect(() => {
      audio.unlock()
      audio.cue('swish')
      audio.setEnabled(false)
      audio.stop()
    }).not.throws()
  })

  it('knows when one of the app’s players is sounding', function () {
    expect(otherAudioSounding()).equals(false)
    setOtherAudio('walkUp', true)
    setOtherAudio('narration', true)
    expect(otherAudioSounding()).equals(true)
    setOtherAudio('walkUp', false)
    expect(otherAudioSounding()).equals(true)
    setOtherAudio('narration', false)
    expect(otherAudioSounding()).equals(false)
  })
})
