import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import { Button, Screen } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'
import type { ChatKeysClient } from './engine/links'
import type { ChatKeyStore } from './keyRecord'
import { LinkDeviceScreen } from './LinkDeviceScreen'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatGateProps {
  engine: Pick<ChatScreenEngine, 'start'>
  client: ChatKeysClient
  userId: number
  /** The key store the engine uses; the platform's own by default. */
  store?: ChatKeyStore
  device?: { name: string; platform: 'web' | 'ios' | 'android' }
  pollMs?: number
  children: React.ReactNode
}

/**
 * What every chat screen stands behind: this device set up for chat.
 *
 * Opening Chat starts the engine (`ensureEnrolled`): a person new to chat
 * enrols here, and a device of someone who already uses chat elsewhere
 * shows `LinkDeviceScreen` until it is linked or reset, then starts again.
 */
export function ChatGate(props: ChatGateProps): React.ReactElement {
  const { engine, client, userId, children } = props
  const styles = getChatStyles(useTheme())
  const [state, setState] = useState<'starting' | 'ready' | 'link' | 'failed'>(
    'starting'
  )
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    setState('starting')
    engine
      .start()
      .then(status => {
        if (live) setState(status === 'ready' ? 'ready' : 'link')
      })
      .catch(() => {
        if (live) setState('failed')
      })
    return () => {
      live = false
    }
  }, [engine, round])

  if (state === 'ready') return <>{children}</>
  if (state === 'link') {
    return (
      <LinkDeviceScreen
        client={client}
        userId={userId}
        store={props.store}
        device={props.device}
        pollMs={props.pollMs}
        onDone={() => {
          setRound(current => current + 1)
        }}
      />
    )
  }
  return (
    <Screen>
      {state === 'failed' ? (
        <>
          <Text style={styles.error}>{lstrings.chat_cannot_load}</Text>
          <Button
            label={lstrings.common_retry}
            kind="secondary"
            onPress={() => {
              setRound(current => current + 1)
            }}
          />
        </>
      ) : (
        <Text style={styles.muted}>{lstrings.chat_loading}</Text>
      )}
    </Screen>
  )
}
