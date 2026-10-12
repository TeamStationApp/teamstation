import { useEffect } from 'react'
import { AppState } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { type PhoneStream, phoneStream } from './phoneStream'

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
    const resume = (): void => {
      const token = client.token
      if (token == null || token === '') return
      phone
        .capabilities()
        .then(async found => {
          if (!alive || !found.supported) return
          await phone.resumePendingUploads(client.baseUrl, token)
        })
        .catch(() => undefined)
    }
    resume()
    const subscription = appState.addEventListener('change', state => {
      if (state === 'active') resume()
    })
    return () => {
      alive = false
      subscription.remove()
    }
  }, [appState, client, phone, signedInAs])
}
