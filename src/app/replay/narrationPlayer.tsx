import { useMemo } from 'react'

import type { NarrationClient, NarrationPlayer } from './narrationPlayerTypes'

/** A moment of silence, played in the tap so later sentences may play. */
const SILENCE =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

const ignore = (): void => undefined

/**
 * The announcer in a browser: one audio element, unlocked in the speaker's
 * tap, playing each sentence from an object URL that is freed once played.
 * The client fetches with its own credentials.
 */
export function webNarrationPlayer(
  client: NarrationClient,
  gameId: string,
  audio: HTMLAudioElement
): NarrationPlayer {
  let finish: (() => void) | null = null
  let unlocked = false
  const start = (): void => {
    const started = audio.play() as Promise<void> | undefined
    started?.catch(() => finish?.())
  }
  return {
    element: null,
    unlock() {
      if (unlocked) return
      unlocked = true
      audio.src = SILENCE
      ;(audio.play() as Promise<void> | undefined)?.catch(ignore)
    },
    output: {
      async load(step, signal) {
        return URL.createObjectURL(
          await client.narrationAudio(gameId, step, signal)
        )
      },
      async play(clip) {
        await new Promise<void>(resolve => {
          finish?.()
          finish = () => {
            finish = null
            audio.onended = null
            audio.onerror = null
            resolve()
          }
          audio.onended = () => finish?.()
          audio.onerror = () => finish?.()
          audio.src = clip
          start()
        })
      },
      pause() {
        audio.pause()
      },
      resume() {
        if (finish != null) start()
      },
      stop() {
        audio.pause()
        finish?.()
      },
      release(clip) {
        URL.revokeObjectURL(clip)
      }
    }
  }
}

export function useNarrationPlayer(
  client: NarrationClient,
  gameId: string
): NarrationPlayer {
  return useMemo(
    () => webNarrationPlayer(client, gameId, document.createElement('audio')),
    [client, gameId]
  )
}
