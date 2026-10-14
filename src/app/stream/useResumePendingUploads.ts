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
 *
 * It also tells the server about every take of this account's it has not
 * heard of. The streaming screen says so when a part ends, and a failed
 * report is said again only when another part ends: after a take's last
 * part, a slide to stop on a weak signal and then Close, nothing would say
 * it again, and the take would never get its upload reminder. So any take
 * never uploaded nor opened for upload, on a stream the camera list still
 * says holds no recording (`localRecording: 'none'`), is reported here.
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
      const recordings = await phone.recordings()
      const pending = recordings.filter(
        recording =>
          recording.hasPendingUpload &&
          !recording.uploadRunning &&
          recording.uploadedAt == null
      )
      // Takes the server has not opened an upload for: what it knows of them
      // is only what the streaming screen managed to tell it.
      const unopened = recordings.filter(
        recording => recording.uploadedAt == null && recording.uploadId == null
      )
      const games = new Map<
        string,
        { pending: PhoneRecording[]; unopened: PhoneRecording[] }
      >()
      const gameOf = (
        gameId: string
      ): { pending: PhoneRecording[]; unopened: PhoneRecording[] } => {
        const found = games.get(gameId) ?? { pending: [], unopened: [] }
        games.set(gameId, found)
        return found
      }
      for (const recording of pending) {
        gameOf(recording.gameId).pending.push(recording)
      }
      for (const recording of unopened) {
        gameOf(recording.gameId).unopened.push(recording)
      }
      for (const [gameId, { pending: takes, unopened: unreported }] of games) {
        // Only takes the server has not opened yet need the camera list.
        // Unreadable, or not this account's game to film: whose those takes
        // are is unknown, so they wait.
        const streams =
          unreported.length === 0
            ? undefined
            : await client.liveStreams(gameId).catch(() => undefined)
        if (!alive) return
        const mine = new Set(streams?.mine.map(stream => stream.id) ?? [])
        for (const take of unreported) {
          const stream = streams?.mine.find(
            item => item.id === take.liveStreamId
          )
          if (stream?.localRecording !== 'none') continue
          client
            .updateLiveStream(gameId, stream.id, { localRecording: 'recorded' })
            .catch(() => undefined)
        }
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
