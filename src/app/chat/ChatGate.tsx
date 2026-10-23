import React, { useEffect, useRef, useState } from 'react'
import { Text } from 'react-native'

import { Button, Screen } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'
import { type ChatKeysClient, leaveChat } from './engine/links'
import { type ChatKeyStore, UnreadableKeyRecordError } from './keyRecord'
import { keyStore } from './keyStore'
import { LinkDeviceScreen } from './LinkDeviceScreen'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatGateProps {
  engine: Pick<ChatScreenEngine, 'start'>
  client: ChatKeysClient
  userId: string
  /** The key store the engine uses; the platform's own by default. */
  store?: ChatKeyStore
  device?: { name: string; platform: 'web' | 'ios' | 'android' }
  pollMs?: number
  /** Told why chat did not start, each time it does not (`chatStartLog`). */
  onFailure?: (error: unknown) => void
  children: React.ReactNode
}

/**
 * What every chat screen stands behind: this device set up for chat.
 *
 * Opening Chat starts the engine (`ensureEnrolled`): a person new to chat
 * enrols here, and a device of someone who already uses chat elsewhere
 * shows `LinkDeviceScreen` until it is linked or reset, then starts again.
 *
 * A start that fails offers another try. When it failed because the keys
 * saved on this device cannot be read, trying again cannot help, so it
 * also offers to reset chat on this device: `leaveChat` wipes the record,
 * and chat starts again as a new device. The record is kept until the
 * person asks for that.
 */
export function ChatGate(props: ChatGateProps): React.ReactElement {
  const { engine, client, userId, children } = props
  const styles = getChatStyles(useTheme())
  const [state, setState] = useState<'starting' | 'ready' | 'link' | 'failed'>(
    'starting'
  )
  const [failure, setFailure] = useState<unknown>(undefined)
  const [resetting, setResetting] = useState(false)
  const [round, setRound] = useState(0)
  const onFailure = useRef(props.onFailure)
  onFailure.current = props.onFailure
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    setState('starting')
    engine
      .start()
      .then(status => {
        if (live) setState(status === 'ready' ? 'ready' : 'link')
      })
      .catch((error: unknown) => {
        onFailure.current?.(error)
        if (!live) return
        setFailure(error)
        setState('failed')
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
  const unreadable = failure instanceof UnreadableKeyRecordError
  const reset = (): void => {
    setResetting(true)
    leaveChat({ client, store: props.store ?? keyStore })
      .then(() => {
        if (mounted.current) setRound(current => current + 1)
      })
      .catch((error: unknown) => {
        onFailure.current?.(error)
        if (mounted.current) setFailure(error)
      })
      .finally(() => {
        if (mounted.current) setResetting(false)
      })
  }
  return (
    <Screen>
      {state === 'failed' ? (
        <>
          <Text style={styles.error}>{lstrings.chat_cannot_load}</Text>
          {unreadable && (
            <Text style={styles.muted}>{lstrings.chat_keys_unreadable}</Text>
          )}
          <Button
            label={lstrings.common_retry}
            kind="secondary"
            disabled={resetting}
            onPress={() => {
              setRound(current => current + 1)
            }}
          />
          {unreadable && (
            <Button
              label={lstrings.chat_reset_submit}
              kind="primary"
              busy={resetting}
              disabled={resetting}
              onPress={reset}
            />
          )}
        </>
      ) : (
        <Text style={styles.muted}>{lstrings.chat_loading}</Text>
      )}
    </Screen>
  )
}
