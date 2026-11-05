import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

import { dictationModelOf, type Health } from '../../common/api'
import { dictationOn } from '../scoring/dictationPlatform'
import type {
  DictationSocket,
  OpenMicrophone,
  TalkKeys
} from '../scoring/dictationTypes'
import { useSpaceToTalk } from '../scoring/spaceToTalk'
import { useDictation } from '../scoring/useDictation'

/** A press held this long records until it is let go; a shorter one is a tap. */
export const PUSH_TO_TALK_MS = 500
/** How long Space is held before Tess records. */
export const SPACE_HOLD_MS = 500
/** How soon a failed health check is asked again; the button waits for one. */
const HEALTH_RETRY_MS = 1000

/**
 * Closed (nothing open), opening (the microphone and the socket starting
 * on a press), recording (an utterance under way), transcribing (ended,
 * waiting for its words).
 */
export type TessMicState = 'idle' | 'opening' | 'recording' | 'transcribing'

/** Where the microphone's loudness goes: one call per frame while it is open. */
export interface LevelSource {
  subscribe: (listener: (level: number) => void) => () => void
}

export interface TessMicrophoneOptions {
  /** Whether this server dictates; asked on mount until it answers. */
  health: () => Promise<Health>
  url: string
  token?: string
  /** The words of an utterance, once it is transcribed. */
  onTranscript: (text: string) => void
  /** A press shorter than this is a tap (`PUSH_TO_TALK_MS`). Tests shorten it. */
  tapMs?: number
  /** How long audio keeps flowing after a release. Tests shorten it. */
  tailMs?: number
  openSocket?: (url: string) => DictationSocket
  openMicrophone?: OpenMicrophone
}

export interface TessMicrophone {
  /** The server dictates, on a platform with a microphone path. */
  available: boolean
  state: TessMicState
  /**
   * Why the microphone could not record, until the next press. An utterance
   * that ends with no words ends quietly: a line appearing under the field
   * would move it.
   */
  message: string | null
  /**
   * The button went down. `at` is when, by the touch's own clock: on a phone
   * the release can be handled long after the finger came up, while the
   * microphone opens, so how long a press lasted is told by its events and
   * not by when they were handled. Without it, now.
   */
  press: (at?: number) => void
  /** The button came up, `at` by the same clock as the press. */
  lift: (at?: number) => void
  /**
   * The press was taken away: on a phone the system takes a finger that moves
   * a little during a tap. It counts as the press coming up, so a short one is
   * still a tap.
   */
  cancel: (at?: number) => void
  /** Starts recording until the next toggle, or ends what is recording. */
  toggle: () => void
  levels: LevelSource
}

/**
 * Tess's microphone, closed until it is asked: no audio and no socket. A
 * press opens both (`setEnabled`), and once the socket is connected the
 * utterance starts with what the microphone has heard since it opened. A
 * press let go before `PUSH_TO_TALK_MS` is a tap, and it records until the
 * next press; one held longer records until it is let go. A release before
 * the socket connects ends the utterance as soon as it starts. Its words, an
 * error, or the socket closing close the microphone again. Space held
 * `SPACE_HOLD_MS` on the web is a held press; a shorter Space is the page's.
 */
export function useTessMicrophone(
  options: TessMicrophoneOptions
): TessMicrophone {
  const {
    health,
    url,
    token,
    tapMs = PUSH_TO_TALK_MS,
    tailMs,
    openSocket,
    openMicrophone
  } = options
  const [available, setAvailable] = useState(false)
  const [offered, setOffered] = useState<readonly string[]>([])
  const [state, setStateNow] = useState<TessMicState>('idle')
  const phase = useRef<TessMicState>('idle')
  const setState = (next: TessMicState): void => {
    phase.current = next
    setStateNow(next)
  }
  // When the press began, the utterance's `since`.
  const pressedAt = useRef(0)
  // When the press began by its touch's own clock, when the touch said.
  const pressStamp = useRef<number | undefined>(undefined)
  // The button is down now.
  const pressing = useRef(false)
  // Let go (or pressed again) before the utterance could start.
  const stopAsked = useRef(false)
  const listeners = useRef(new Set<(level: number) => void>())
  const levels = useRef<LevelSource>({
    subscribe: listener => {
      listeners.current.add(listener)
      return () => {
        listeners.current.delete(listener)
      }
    }
  }).current
  const transcript = useRef(options.onTranscript)
  transcript.current = options.onTranscript
  const close = useRef<() => void>(() => undefined)
  // What the server said about an utterance that ended with no words; not shown.
  const quiet = useRef<string | null>(null)
  const dictation = useDictation({
    url,
    scope: 'tess',
    target: {},
    contextOf: () => 'tess',
    onTranscript: text => {
      close.current()
      transcript.current(text)
    },
    onLevel: level => {
      for (const listener of listeners.current) listener(level)
    },
    model: dictationModelOf(undefined, offered),
    tailMs,
    token,
    openSocket,
    openMicrophone
  })
  const { setEnabled } = dictation
  close.current = () => {
    pressing.current = false
    stopAsked.current = false
    setEnabled(false)
    setState('idle')
  }

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (): void => {
      health().then(
        reply => {
          if (!live) return
          setAvailable(reply.dictation)
          setOffered(reply.dictationModels)
        },
        () => {
          if (!live) return
          timer = setTimeout(ask, HEALTH_RETRY_MS)
        }
      )
    }
    ask()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [health])

  const latest = useRef(dictation)
  latest.current = dictation
  /** Ends what is recording; one still opening ends as soon as it starts. */
  const stop = useCallback((): void => {
    if (phase.current === 'opening') {
      // Asked twice before it could start: the socket is not coming.
      if (stopAsked.current) close.current()
      else stopAsked.current = true
      return
    }
    if (phase.current !== 'recording') return
    latest.current.release()
    setState('transcribing')
  }, [])
  const begin = useCallback(
    (since: number): void => {
      pressedAt.current = since
      stopAsked.current = false
      setState('opening')
      setEnabled(true)
    },
    [setEnabled]
  )

  // Connected while opening: the utterance starts, led by the pre-roll.
  const { connected, enabled, holding, busy } = dictation
  useEffect(() => {
    if (state === 'opening') {
      // The microphone could not open; dictation switched itself off.
      if (!enabled) {
        close.current()
        return
      }
      if (!connected) return
      if (!latest.current.hold(pressedAt.current)) {
        close.current()
        return
      }
      setState('recording')
      if (stopAsked.current) {
        stopAsked.current = false
        stop()
      }
      return
    }
    // The socket closed, or the server gave up, mid-utterance or after.
    if (state === 'recording' && !holding) close.current()
    if (state === 'transcribing' && !busy) {
      quiet.current = latest.current.message
      close.current()
    }
  }, [state, connected, enabled, holding, busy, stop])

  const keys = useRef<TalkKeys>({ hold: () => false, release: () => {} })
  keys.current = {
    hold: since => {
      if (phase.current !== 'idle') return false
      pressing.current = true
      pressStamp.current = undefined
      begin(since ?? Date.now())
      return true
    },
    release: () => {
      pressing.current = false
      stop()
    }
  }
  /** The press came up, or was taken away: a tap keeps recording until the next press. */
  const lift = (at?: number): void => {
    if (!pressing.current) return
    pressing.current = false
    // By the touch's clock when both ends have one: the two are only
    // comparable with each other.
    const start = pressStamp.current
    const held =
      at != null && start != null ? at - start : Date.now() - pressedAt.current
    if (held < tapMs) return
    stop()
  }
  const usable = available && dictationOn(Platform.OS)
  useSpaceToTalk(usable, true, keys, { holdMs: SPACE_HOLD_MS })

  return {
    available: usable,
    state,
    message: dictation.message === quiet.current ? null : dictation.message,
    press: at => {
      if (phase.current === 'transcribing') return
      if (phase.current !== 'idle') {
        // The press after a tap ends what the tap started.
        stop()
        return
      }
      pressing.current = true
      pressStamp.current = at
      begin(Date.now())
    },
    lift: at => {
      lift(at)
    },
    cancel: at => {
      lift(at)
    },
    toggle: () => {
      if (phase.current === 'idle') begin(Date.now())
      else stop()
    },
    levels
  }
}
