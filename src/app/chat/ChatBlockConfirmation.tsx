import React, { useEffect, useRef, useState } from 'react'
import { Text } from 'react-native'

import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatActionOverlay } from './ChatActionOverlay'
import { getChatStyles } from './chatStyles'

export type ChatSafetyAction = 'block' | 'unblock' | 'report' | 'reportAndBlock'

/** One confirmed write; failures remain open and can be retried. */
export function ChatBlockConfirmation(props: {
  name: string
  action: ChatSafetyAction
  onConfirm: () => Promise<void>
  onClose: () => void
  onSuccess?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getChatStyles(theme)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const running = useRef(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const unblock = props.action === 'unblock'
  const report = props.action === 'report' || props.action === 'reportAndBlock'
  const label =
    props.action === 'reportAndBlock'
      ? lstrings.chat_report_and_block
      : report
        ? lstrings.chat_report_send
        : unblock
          ? lstrings.chat_unblock
          : lstrings.chat_block
  const title = report
    ? lstrings.chat_report_title
    : sprintf(
        unblock ? lstrings.chat_unblock_title : lstrings.chat_block_title,
        props.name
      )
  const close = (): void => {
    if (!running.current) props.onClose()
  }
  const confirm = (): void => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setFailed(false)
    props
      .onConfirm()
      .then(() => {
        if (!live.current) return
        props.onSuccess?.()
        props.onClose()
      })
      .catch(() => {
        if (live.current) setFailed(true)
      })
      .finally(() => {
        running.current = false
        if (live.current) setBusy(false)
      })
  }
  return (
    <ChatActionOverlay label={title} onClose={close}>
      <Text style={styles.title}>{title}</Text>
      {report && (
        <Text style={styles.muted}>
          {sprintf(lstrings.chat_report_detail, props.name)}
        </Text>
      )}
      {props.action !== 'report' && (
        <Text style={styles.muted}>
          {unblock ? lstrings.chat_unblock_detail : lstrings.chat_block_detail}
        </Text>
      )}
      {failed && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {lstrings.chat_block_failed}
        </Text>
      )}
      <Button
        testID="chat-safety-confirm"
        label={label}
        accessibilityLabel={label}
        color={unblock ? undefined : theme.dangerColor}
        busy={busy}
        onPress={confirm}
      />
      <CancelAction
        testID="chat-safety-cancel"
        destructivePrimary={!unblock}
        disabled={busy}
        onPress={close}
      />
    </ChatActionOverlay>
  )
}
