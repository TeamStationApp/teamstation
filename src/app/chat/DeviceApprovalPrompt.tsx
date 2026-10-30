import React, { createContext, useContext, useSyncExternalStore } from 'react'
import { Modal, ScrollView, Text, View } from 'react-native'

import type { ChatPendingLink } from '../../common/api'
import { Button, Card } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'
import { type DeviceApprovals, EMPTY_APPROVAL_STATE } from './deviceApprovals'
import { pendingLinkCode, spacedCode } from './engine/links'

export const DeviceApprovalContext = createContext<DeviceApprovals | undefined>(
  undefined
)
const noSubscribe = (): (() => void) => () => {}
const empty = (): typeof EMPTY_APPROVAL_STATE => EMPTY_APPROVAL_STATE

export function useDeviceApprovals(): {
  controller: DeviceApprovals | undefined
  state: ReturnType<DeviceApprovals['snapshot']>
} {
  const controller = useContext(DeviceApprovalContext)
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.snapshot ?? empty
  )
  return { controller, state }
}

export function DeviceApprovalActions(props: {
  id: string
  onDecided?: () => void
  showCode?: boolean
}): React.ReactElement {
  const { controller, state } = useDeviceApprovals()
  const theme = useTheme()
  const styles = getChatStyles(theme)
  const link = state.links.find(link => link.id === props.id)
  if (!state.ready)
    return (
      <Text style={styles.muted}>
        {lstrings.chat_approval_on_linked_device}
      </Text>
    )
  if (link == null)
    return <Text style={styles.muted}>{lstrings.common_loading}</Text>
  const decide = (decision: 'approve' | 'decline'): void => {
    controller
      ?.decide(props.id, decision)
      .then(props.onDecided)
      .catch(() => undefined)
  }
  return (
    <View style={{ gap: theme.rem(0.5) }}>
      {props.showCode !== false && (
        <>
          <Text style={styles.muted}>
            {sprintf(lstrings.chat_devices_request_detail, link.newDevice.name)}
          </Text>
          <Text
            style={styles.heading}
            accessibilityLabel={sprintf(
              lstrings.chat_devices_code_label,
              pendingLinkCode(link)
            )}
          >
            {spacedCode(pendingLinkCode(link))}
          </Text>
        </>
      )}
      {state.error != null && <Text style={styles.error}>{state.error}</Text>}
      <View style={styles.actions}>
        <Button
          label={lstrings.chat_devices_approve}
          accessibilityLabel={sprintf(
            lstrings.chat_devices_approve_label,
            link.newDevice.name
          )}
          busy={state.busy === props.id}
          disabled={state.busy != null}
          onPress={() => {
            decide('approve')
          }}
        />
        <Button
          label={lstrings.chat_devices_decline}
          accessibilityLabel={sprintf(
            lstrings.chat_devices_decline_label,
            link.newDevice.name
          )}
          kind="secondary"
          disabled={state.busy != null}
          onPress={() => {
            decide('decline')
          }}
        />
      </View>
    </View>
  )
}

export function DeviceApprovalDetails({
  link
}: {
  link: ChatPendingLink
}): React.ReactElement {
  const styles = getChatStyles(useTheme())
  const platform =
    link.newDevice.platform === 'web'
      ? lstrings.chat_devices_platform_web
      : link.newDevice.platform === 'ios'
        ? lstrings.chat_devices_platform_ios
        : lstrings.chat_devices_platform_android
  return (
    <>
      <Text style={styles.heading}>
        {sprintf(lstrings.chat_devices_request, link.newDevice.name)}
      </Text>
      <Text style={styles.muted}>
        {platform} · {new Date(link.createdAt).toLocaleString()}
      </Text>
    </>
  )
}

export function DeviceApprovalPrompt(): React.ReactElement | null {
  const { controller, state } = useDeviceApprovals()
  const theme = useTheme()
  const link = state.ready
    ? state.links.find(link => !state.dismissed.has(link.id))
    : undefined
  if (link == null) return null
  const close = (): void => {
    controller?.dismiss(link.id)
  }
  return (
    <Modal transparent visible animationType="fade" onRequestClose={close}>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          backgroundColor: theme.overlayBackgroundColor,
          padding: theme.rem(1)
        }}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        >
          <Card
            testID="chat-device-approval-prompt"
            style={{
              width: '100%',
              maxWidth: theme.rem(32),
              alignSelf: 'center',
              gap: theme.rem(1)
            }}
          >
            <DeviceApprovalDetails link={link} />
            <DeviceApprovalActions id={link.id} />
            <Button
              label={lstrings.chat_approval_later}
              kind="text"
              onPress={close}
            />
          </Card>
        </ScrollView>
      </View>
    </Modal>
  )
}
