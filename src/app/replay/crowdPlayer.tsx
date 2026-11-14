import { useCallback, useEffect, useRef } from 'react'

import cheerHuge from '../assets/crowd/cheer-huge.m4a'
import cheerLarge from '../assets/crowd/cheer-large.m4a'
import cheerMedium from '../assets/crowd/cheer-medium.m4a'
import cheerSmall from '../assets/crowd/cheer-small.m4a'
import crowdIdle from '../assets/crowd/crowd-idle.m4a'
import {
  bedGains,
  CHEER_GAIN,
  type CheerSize,
  type Crowd,
  CROWD_IDLE_GAIN,
  MAX_CHEERS,
  nextStartsAt
} from './crowdCheer'
import { SILENCE, start } from './webAudio'

/** Each cheer's sound. */
export const CHEER_SOUNDS: Record<CheerSize, string> = {
  small: cheerSmall,
  medium: cheerMedium,
  large: cheerLarge,
  huge: cheerHuge
}
/** The idle crowd, played as copies that overlap. */
export const CROWD_IDLE_SOUND = crowdIdle

/** How often the idle crowd's copies are levelled, and the next started. */
export const CROWD_TICK_MS = 50

/** An element's duration, once known; until then, endless. */
const durationOf = (audio: HTMLMediaElement): number =>
  Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : Infinity

/** A browser's Web Audio context, under either of its names, if it has one. */
function audioContextClass(): typeof AudioContext | undefined {
  const page = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return page.AudioContext ?? page.webkitAudioContext
}

/**
 * Sets each element's level: through Web Audio where the browser has it,
 * as iPhone and iPad Safari ignore an element's `volume` set from script and
 * play every element at 1. Each element is routed once, on first use after
 * the context is made, into its own GainNode: `createMediaElementSource` may
 * be called only once per element. Its `volume` then stays 1 and the node
 * holds the gain. Where there is no context, or routing an element throws,
 * its `volume` holds the gain, as before.
 *
 * Web Audio plays a cross-origin element as silence unless it is fetched with
 * CORS. The crowd's sounds are bundled assets served from the app's own
 * origin (`/crowd-idle-….m4a`, `/cheer-….m4a`, as the crowd end-to-end test
 * checks), and the unlock's SILENCE is a data URL, so none needs `crossOrigin`.
 */
class CrowdMixer {
  private context: AudioContext | null = null
  private readonly gains = new WeakMap<HTMLMediaElement, GainNode | null>()

  /** Makes the context and resumes it: only inside a tap, for Safari. */
  open(): void {
    if (this.context != null) return
    const Context = audioContextClass()
    if (Context == null) return
    try {
      this.context = new Context()
      ;(this.context.resume() as Promise<void> | undefined)?.catch(
        () => undefined
      )
    } catch {
      this.context = null
    }
  }

  /** The element's own gain node, routing it the first time; null if it cannot be. */
  private nodeOf(audio: HTMLMediaElement): GainNode | null {
    const known = this.gains.get(audio)
    if (known !== undefined) return known
    const { context } = this
    if (context == null) return null
    let node: GainNode | null = null
    try {
      const source = context.createMediaElementSource(audio)
      node = context.createGain()
      source.connect(node)
      node.connect(context.destination)
    } catch {
      node = null
    }
    // Once routed or refused, never again: a second source would throw.
    this.gains.set(audio, node)
    return node
  }

  /** Plays the element at `gain`, on its node if it has one, else by `volume`. */
  level(audio: HTMLMediaElement, gain: number): void {
    const node = this.nodeOf(audio)
    if (node == null) {
      audio.volume = gain
      return
    }
    node.gain.value = gain
    audio.volume = 1
  }

  close(): void {
    const { context } = this
    this.context = null
    if (context == null) return
    try {
      ;(context.close() as Promise<void> | undefined)?.catch(() => undefined)
    } catch {
      // Already closed.
    }
  }
}

/**
 * The stadium crowd under the replay, in a browser: the idle murmur, playing
 * while the sound is on and the replay is neither paused nor over, and a
 * pool of MAX_CHEERS elements the cheers take turns on, a free one first,
 * else the oldest, which stops. Pausing pauses the cheers sounding and
 * playing plays them on; a cheer raised while paused is held, ready, and
 * starts on play, as a phone's paused cheer does. The end of the replay lets
 * them play out. Turning the sound off, or leaving, stops them all.
 *
 * The murmur is two elements of the same file, neither looping, that take
 * turns: every CROWD_TICK_MS the copy playing is levelled by `bedGains`, and
 * once it reaches `nextStartsAt` the other starts from its beginning, the
 * two crossing over CROWD_CROSSFADE_SECONDS, and the first rests when it
 * ends. While both play, both gains follow the outgoing copy's position, so
 * they stay equal power whatever the other's start lagged by. Pausing, or
 * the end of the replay, pauses whichever copies play, and playing plays
 * them on, their gains still read from where each stands. Turning the sound
 * off rests both at their start, so turning it on brings the crowd in again.
 *
 * A browser such as iPhone Safari lets an element play only once it has
 * played in a tap: `unlock`, called in the volume button's tap, makes both
 * copies and the pool and plays each there, the copies muted and paused
 * again at once, each cheer's element a moment of silence. It also makes the
 * Web Audio context the mix plays through, and resumes it, in that tap
 * (`CrowdMixer`).
 */
export function useCrowd(options: {
  on: boolean
  paused: boolean
  over: boolean
}): Crowd {
  const { on, paused, over } = options
  /** The idle crowd's two copies, made on first use. */
  const beds = useRef<HTMLAudioElement[]>([])
  /** The copies playing or paused part way, the oldest first. */
  const sounding = useRef<HTMLAudioElement[]>([])
  const ticker = useRef<ReturnType<typeof window.setInterval> | null>(null)
  const pool = useRef<HTMLAudioElement[]>([])
  /** The cheers sounding, the oldest first. */
  const cheers = useRef<HTMLAudioElement[]>([])
  const live = useRef(on)
  const held = useRef(paused)
  const unlocked = useRef(false)
  const mixer = useRef<CrowdMixer | null>(null)
  const mixerOf = useCallback((): CrowdMixer => {
    mixer.current ??= new CrowdMixer()
    return mixer.current
  }, [])
  const bedsOf = useCallback((): HTMLAudioElement[] => {
    if (beds.current.length === 0)
      beds.current = [0, 1].map(() => {
        // An audio element of the page's, never in the document.
        const audio = document.createElement('audio')
        audio.src = CROWD_IDLE_SOUND
        mixerOf().level(audio, 0)
        // It rests once it ends; the other has taken over.
        audio.onended = () => {
          sounding.current = sounding.current.filter(other => other !== audio)
        }
        return audio
      })
    return beds.current
  }, [mixerOf])
  /** Levels each copy: those sounding by where the outgoing stands, else 0. */
  const levelBeds = useCallback((): void => {
    const mix = mixerOf()
    const [outgoing, incoming] = sounding.current
    for (const audio of beds.current)
      if (audio !== outgoing && audio !== incoming) mix.level(audio, 0)
    if (outgoing == null) return
    const at = outgoing.currentTime
    const length = durationOf(outgoing)
    mix.level(outgoing, CROWD_IDLE_GAIN * bedGains(at, length))
    if (incoming != null)
      mix.level(
        incoming,
        CROWD_IDLE_GAIN *
          bedGains(at - nextStartsAt(length), durationOf(incoming))
      )
  }, [mixerOf])
  /** Starts a copy from its beginning, silent until levelled. */
  const begin = useCallback(
    (audio: HTMLAudioElement): void => {
      audio.currentTime = 0
      mixerOf().level(audio, 0)
      sounding.current = [...sounding.current, audio]
      start(audio)
    },
    [mixerOf]
  )
  /**
   * Starts the first copy, or the next once the one playing reaches
   * `nextStartsAt`, and levels them.
   */
  const tick = useCallback((): void => {
    const [first, second] = bedsOf()
    const [outgoing] = sounding.current
    if (outgoing == null) begin(first)
    else if (
      sounding.current.length === 1 &&
      outgoing.currentTime >= nextStartsAt(durationOf(outgoing))
    )
      begin(outgoing === first ? second : first)
    levelBeds()
  }, [bedsOf, begin, levelBeds])
  const stopTicking = useCallback((): void => {
    if (ticker.current != null) window.clearInterval(ticker.current)
    ticker.current = null
  }, [])
  /** Rests both copies at their start. */
  const restBeds = useCallback((): void => {
    stopTicking()
    for (const audio of beds.current) {
      audio.pause()
      audio.currentTime = 0
    }
    sounding.current = []
  }, [stopTicking])
  const poolOf = useCallback((): HTMLAudioElement[] => {
    if (pool.current.length === 0)
      pool.current = Array.from({ length: MAX_CHEERS }, () => {
        const audio = document.createElement('audio')
        audio.onended = () => {
          cheers.current = cheers.current.filter(other => other !== audio)
        }
        return audio
      })
    return pool.current
  }, [])
  const hush = useCallback((): void => {
    for (const audio of cheers.current) audio.pause()
    cheers.current = []
  }, [])
  useEffect(() => {
    live.current = on
    if (!on) {
      restBeds()
      hush()
      return
    }
    bedsOf()
    if (paused || over) {
      stopTicking()
      for (const audio of sounding.current) audio.pause()
      return
    }
    levelBeds()
    for (const audio of sounding.current) start(audio)
    tick()
    ticker.current = window.setInterval(tick, CROWD_TICK_MS)
    return stopTicking
  }, [on, paused, over, hush, bedsOf, levelBeds, restBeds, stopTicking, tick])
  useEffect(() => {
    held.current = paused
    if (!on) return
    for (const cheer of cheers.current)
      if (paused) cheer.pause()
      else start(cheer)
  }, [on, paused])
  useEffect(
    () => () => {
      live.current = false
      restBeds()
      beds.current = []
      hush()
      pool.current = []
      mixer.current?.close()
      mixer.current = null
    },
    [hush, restBeds]
  )
  const unlock = useCallback((): void => {
    if (unlocked.current) return
    unlocked.current = true
    const mix = mixerOf()
    mix.open()
    const copies = bedsOf()
    // Routes the copies, if made before the context, each at its gain.
    levelBeds()
    for (const audio of copies) {
      if (sounding.current.includes(audio)) continue
      audio.muted = true
      start(audio)
      audio.pause()
      audio.muted = false
    }
    for (const cheer of poolOf()) {
      cheer.src = SILENCE
      start(cheer)
    }
  }, [bedsOf, levelBeds, poolOf, mixerOf])
  const cheer = useCallback(
    (size: CheerSize): void => {
      if (!live.current) return
      const free = poolOf().find(audio => !cheers.current.includes(audio))
      const audio = free ?? cheers.current[0]
      if (free == null) audio.pause()
      audio.src = CHEER_SOUNDS[size]
      mixerOf().level(audio, CHEER_GAIN[size])
      audio.currentTime = 0
      cheers.current = [
        ...cheers.current.filter(other => other !== audio),
        audio
      ]
      if (!held.current) start(audio)
    },
    [poolOf, mixerOf]
  )
  return { element: null, cheer, unlock }
}
