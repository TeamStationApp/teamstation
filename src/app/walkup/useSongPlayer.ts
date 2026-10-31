import { useCallback, useEffect, useRef, useState } from 'react'

import type { WalkUpProvider } from '../../common/walkUpSong'
import { useSceneShown } from '../components/sceneShown'
import { WALK_UP_FADE, type WalkUpMusic } from './walkUpMusicTypes'

/** A clip to play, and the key a screen knows it by (a row, a button). */
export interface ClipRequest {
  key: string
  handle: string
  provider: WalkUpProvider
  startMs: number
  endMs: number
}

/**
 * The fades a clip plays with. A file always fades, on the player's own
 * volume. Apple Music can fade only by moving the phone's volume, so it
 * fades only while `fadeAppleMusic` is on, and otherwise starts and stops
 * hard. The fade in matches the fade out, and a clip that starts at 0 s
 * has no fade in.
 */
export function clipFade(
  provider: WalkUpProvider,
  fadeAppleMusic: boolean,
  startMs: number
): { inMs: number; outMs: number } {
  if (provider === 'appleMusic' && !fadeAppleMusic) return { inMs: 0, outMs: 0 }
  return {
    inMs: startMs > 0 ? WALK_UP_FADE.outMs : 0,
    outMs: WALK_UP_FADE.outMs
  }
}

export interface SongPlayer {
  /** The key of the clip playing, or null. */
  playing: string | null
  /** Why the last clip would not play, until the next one is asked for. */
  error: string | null
  play: (clip: ClipRequest) => void
  /** Play the clip, or fade it out when it is the one playing: a second tap. */
  toggle: (clip: ClipRequest) => void
  /** Fade out over `fadeMs`, 0 for at once. */
  stop: (fadeMs?: number) => void
}

/**
 * Playback for one screen: one clip at a time. Starting a clip replaces the
 * one playing, a second tap on the same one fades it out, the clip's own end
 * (`idle`) clears it, and leaving the screen stops it, because a song still
 * playing from a page nobody can see has no button left to stop it with.
 */
export function useSongPlayer(
  music: WalkUpMusic,
  fadeAppleMusic = true
): SongPlayer {
  const [playing, setPlaying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const playingRef = useRef<string | null>(null)
  const set = useCallback((key: string | null) => {
    playingRef.current = key
    setPlaying(key)
  }, [])

  useEffect(() => {
    if (!music.available) return
    const unsubscribe = music.onState(state => {
      if (state.kind === 'playing') return
      set(null)
      if (state.kind === 'error') setError(state.message)
    })
    return () => {
      unsubscribe()
      if (playingRef.current != null) music.stop(0).catch(() => undefined)
      playingRef.current = null
    }
  }, [music, set])

  const stop = useCallback(
    (fadeMs = 0) => {
      set(null)
      music.stop(fadeMs).catch(() => undefined)
    },
    [music, set]
  )

  // A screen pushed over this one (the song picker over the DJ's list) leaves
  // no Stop on show.
  const shown = useSceneShown()
  useEffect(() => {
    if (!shown && playingRef.current != null) stop()
  }, [shown, stop])

  const play = useCallback(
    (clip: ClipRequest) => {
      setError(null)
      set(clip.key)
      music
        .play(
          clip.handle,
          clip.startMs,
          clip.endMs,
          clipFade(clip.provider, fadeAppleMusic, clip.startMs)
        )
        .catch((caught: unknown) => {
          if (playingRef.current === clip.key) set(null)
          setError(caught instanceof Error ? caught.message : String(caught))
        })
    },
    [music, fadeAppleMusic, set]
  )

  const toggle = useCallback(
    (clip: ClipRequest) => {
      if (playingRef.current === clip.key) {
        stop(clipFade(clip.provider, fadeAppleMusic, clip.startMs).outMs)
      } else play(clip)
    },
    [fadeAppleMusic, play, stop]
  )

  return { playing, error, play, toggle, stop }
}
