import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import { chatCoreStatus, loadChatCore } from '../../common/chatCrypto/core'
import type {
  ChatCoreStatus,
  CoreUnavailableReason
} from '../../common/chatCrypto/coreCall'
import { Screen } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'
import { ChatUnavailable } from './ChatUnavailable'

export interface ChatCoreGateProps {
  /** Loads this platform's chat crypto core; the real one by default. */
  loadCore?: () => Promise<ChatCoreStatus>
  /** The core's status as it stands; the real one by default. */
  coreStatus?: () => ChatCoreStatus
  /** Told once why the core is not there, for the log. */
  onUnavailable?: (reason: CoreUnavailableReason) => void
  children: React.ReactNode
}

/**
 * What everything chat stands behind: this platform's chat crypto core,
 * loaded and checked. In a browser that is the WebAssembly module; on a
 * phone, the native module. Until it is ready nothing below mounts, so
 * nothing enrols, links, resumes or opens the key store, and when it cannot
 * be had, `ChatUnavailable` says why instead. There is no other
 * implementation to fall back on.
 */
export function ChatCoreGate(props: ChatCoreGateProps): React.ReactElement {
  const {
    loadCore = loadChatCore,
    coreStatus = chatCoreStatus,
    onUnavailable,
    children
  } = props
  const styles = getChatStyles(useTheme())
  // Settled already (a phone's, or a browser's after its first chat screen):
  // drawn at once, with no "Opening chat…" between screens. A module that
  // did not arrive is asked for again below, so it is not settled.
  const [status, setStatus] = useState<ChatCoreStatus | undefined>(() => {
    const now = coreStatus()
    const settled =
      now.ready || (now.reason !== 'loading' && now.reason !== 'fetchFailed')
    return settled ? now : undefined
  })

  useEffect(() => {
    let live = true
    loadCore()
      .then(settled => {
        if (!live) return
        setStatus(settled)
        if (!settled.ready) onUnavailable?.(settled.reason)
      })
      .catch(() => {
        if (!live) return
        setStatus({ ready: false, reason: 'instantiateFailed' })
        onUnavailable?.('instantiateFailed')
      })
    return () => {
      live = false
    }
  }, [loadCore, onUnavailable])

  if (status?.ready === true) return <>{children}</>
  if (status == null) {
    return (
      <Screen>
        <Text style={styles.muted}>{lstrings.chat_loading}</Text>
      </Screen>
    )
  }
  return <ChatUnavailable reason={status.reason} />
}
