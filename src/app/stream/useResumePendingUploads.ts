import { useEffect } from 'react'
import { AppState } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  type PhoneRecording,
  type PhoneStream,
  phoneStream
} from './phoneStream'

/** The part of React Native's `AppState` this needs; a test hands in its own. */
export interface AppStateLike {
  addEventListener: (
    type: 'change',
    listener: (state: string) => void
  ) => { remove: () => void }
}

/**
 * Carries on every recording upload that was cut off: once somebody is signed
 * in at launch, and again each time the app comes back to the front. A killed
 * app, or a phone back from its lock screen, picks up from the parts the
 * server already has; an upload already running in this process is left to
 * run. Nothing happens on a phone that cannot record, nor in a browser.
 *
 * Only the signed-in account's own takes. A take the server already opened
 * an upload for carries its id, and that upload is its opener's: the server
 * answers it only to that account, so it resumes as it is, even once the
 * server has finished it and revoked the take's stream (it then reads as
 * done). A take cut off before the server opened it is filmed into a stream,
 * and the stream is its account's: the game's camera list says which are this
 * account's (`mine`). A take on a stream that is not among them was made by
 * somebody else who used this phone, or cannot be told apart from one, and is
 * left waiting for them. Opened under the wrong account it would land as that
 * account's upload, and its maker's reminder would never settle.
 */
export function useResumePendingUploads(
  client: TeamStationClient,
  signedInAs: unknown,
  phone: PhoneStream = phoneStream,
  appState: AppStateLike = AppState
): void {
  useEffect(() => {
    if (signedInAs == null) return
    let alive = true
    const resume = async (): Promise<void> => {
      const token = client.token
      if (token == null || token === '') return
      const found = await phone.capabilities()
      if (!alive || !found.supported) return
      const pending = (await phone.recordings()).filter(
        recording =>
          recording.hasPendingUpload &&
          !recording.uploadRunning &&
          recording.uploadedAt == null
      )
      const games = new Map<string, PhoneRecording[]>()
      for (const recording of pending) {
        games.set(recording.gameId, [
          ...(games.get(recording.gameId) ?? []),
          recording
        ])
      }
      for (const [gameId, takes] of games) {
        // Only takes the server has not opened yet need the camera list.
        // Unreadable, or not this account's game to film: whose those takes
        // are is unknown, so they wait.
        const streams = takes.every(take => take.uploadId != null)
          ? undefined
          : await client.liveStreams(gameId).catch(() => undefined)
        if (!alive) return
        const mine = new Set(streams?.mine.map(stream => stream.id) ?? [])
        for (const take of takes) {
          if (take.uploadId == null && !mine.has(take.liveStreamId)) continue
          phone
            .resumeUpload({
              liveStreamId: take.liveStreamId,
              apiBase: client.baseUrl,
              token,
              title: take.uploadTitle ?? take.angleName
            })
            .catch(() => undefined)
        }
      }
    }
    const resumeQuietly = (): void => {
      resume().catch(() => undefined)
    }
    resumeQuietly()
    const subscription = appState.addEventListener('change', state => {
      if (state === 'active') resumeQuietly()
    })
    return () => {
      alive = false
      subscription.remove()
    }
  }, [appState, client, phone, signedInAs])
}
