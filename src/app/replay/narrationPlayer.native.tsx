import React, { useEffect, useMemo, useRef, useState } from 'react'
import Video from 'react-native-video'

import { setOtherAudio } from '../scoring/cueSoundsController'
import type { NarrationClient, NarrationPlayer } from './narrationPlayerTypes'
import type { NarrationStep } from './narrationQueue'

/**
 * The announcer on a phone: a hidden player that fetches the sentence
 * itself with the client's header, sounds with the ring switch on silent and
 * mixes with the field's cues and any music. A request without the audio
 * first proves the sentence is there, so a failure is counted before
 * anything plays and the sentence is downloaded once. Both ask for the step
 * as it stood when it was queued, so the sentence is the one on the card.
 * While a sentence plays the cues leave the audio session to this player.
 */
export function useNarrationPlayer(
  client: NarrationClient,
  gameId: string
): NarrationPlayer<NarrationStep> {
  const [playing, setPlaying] = useState<{
    source: { uri: string; headers: Record<string, string> }
    paused: boolean
    /** Which play this is: each one mounts its own player. */
    play: number
  } | null>(null)
  const finish = useRef<(() => void) | null>(null)
  // A step read again (its sentence changed) has the same address, which an
  // Android player already holding it would not load afresh.
  const plays = useRef(0)
  // The cues leave the audio session alone while a sentence's player is
  // mounted, and only then: that player sets the session to playback and
  // would answer a switch back by flipping it again. Between sentences
  // there is none, and the cues keep the session ambient.
  const mounted = playing != null
  useEffect(() => {
    setOtherAudio('narration', mounted)
  }, [mounted])
  useEffect(
    () => () => {
      setOtherAudio('narration', false)
    },
    []
  )
  const end = (): void => {
    const done = finish.current
    finish.current = null
    setPlaying(null)
    done?.()
  }
  const player = useMemo<Omit<NarrationPlayer<NarrationStep>, 'element'>>(
    () => ({
      unlock() {},
      output: {
        async load(step, signal) {
          await client.narrationReady(gameId, step, signal)
          return step
        },
        async play(step) {
          await new Promise<void>(resolve => {
            finish.current?.()
            finish.current = resolve
            setPlaying({
              source: client.narrationSource(gameId, step),
              paused: false,
              play: ++plays.current
            })
          })
        },
        pause() {
          setPlaying(now => (now == null ? now : { ...now, paused: true }))
        },
        resume() {
          setPlaying(now => (now == null ? now : { ...now, paused: false }))
        },
        stop() {
          const done = finish.current
          finish.current = null
          setPlaying(null)
          done?.()
        },
        release() {}
      }
    }),
    [client, gameId]
  )
  return {
    ...player,
    element:
      playing == null ? null : (
        <Video
          key={playing.play}
          source={playing.source}
          paused={playing.paused}
          ignoreSilentSwitch="ignore"
          mixWithOthers="mix"
          style={{ width: 0, height: 0 }}
          onEnd={end}
          onError={end}
        />
      )
  }
}
