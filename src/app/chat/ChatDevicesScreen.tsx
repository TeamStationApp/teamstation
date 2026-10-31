import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { ChatDevice, ChatPendingLink } from '../../common/api'
import {
  Button,
  Card,
  initialsOf,
  ListRow,
  Screen,
  SectionHeader
} from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  DeviceApprovalActions,
  useDeviceApprovals
} from './DeviceApprovalPrompt'
import {
  approveLink,
  type ChatKeysClient,
  ensureEnrolled,
  pendingLinkCode,
  revokeOtherDevice,
  spacedCode
} from './engine/links'
import type { ChatKeyRecord, ChatKeyStore } from './keyRecord'
import { keyStore } from './keyStore'
import { LinkDeviceScreen } from './LinkDeviceScreen'
import { thisDevice } from './thisDevice'

/** How often the list is read again while it is open. */
export const DEVICES_POLL_MS = 3000

export interface ChatDevicesScreenProps {
  client: ChatKeysClient
  userId: string
  /** This device's key store; the platform's own by default. */
  store?: ChatKeyStore
  /** How this device names itself; read from the platform by default. */
  device?: { name: string; platform: 'web' | 'ios' | 'android' }
  pollMs?: number
}

interface Listing {
  devices: ChatDevice[]
  links: ChatPendingLink[]
}

const platformName = (device: Pick<ChatDevice, 'platform'>): string =>
  device.platform === 'web'
    ? lstrings.chat_devices_platform_web
    : device.platform === 'ios'
      ? lstrings.chat_devices_platform_ios
      : lstrings.chat_devices_platform_android

/**
 * Every device that can read the user's chats, the requests of new ones
 * with their six digits to approve, and Remove for the others.
 *
 * Opening it enrols this device (`ensureEnrolled`): a user new to chat gets
 * an identity here; a device of a user who already has one shows
 * `LinkDeviceScreen` in its place until it is linked or reset.
 *
 * Kept through a change of user, it starts again for the one signed in now.
 */
export function ChatDevicesScreen(
  props: ChatDevicesScreenProps
): React.ReactElement {
  return <ChatDevices key={props.userId} {...props} />
}

function ChatDevices(props: ChatDevicesScreenProps): React.ReactElement {
  const { client, userId } = props
  const store = props.store ?? keyStore
  const pollMs = props.pollMs ?? DEVICES_POLL_MS
  const styles = getStyles(useTheme())
  const approvals = useDeviceApprovals()
  const setup = useRef({
    client,
    store,
    userId,
    device: props.device ?? thisDevice()
  }).current

  const [record, setRecord] = useState<ChatKeyRecord | undefined>(undefined)
  const [linking, setLinking] = useState(false)
  const [failed, setFailed] = useState(false)
  const [listing, setListing] = useState<Listing | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    setFailed(false)
    ensureEnrolled(setup)
      .then(enrolment => {
        if (!live) return
        if (enrolment.state === 'ready') {
          setRecord(enrolment.record)
          setLinking(false)
        } else {
          setLinking(true)
        }
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [round, setup])

  const load = useCallback(async (): Promise<Listing> => {
    const [devices, links] = await Promise.all([
      client.chatDevices(),
      client.chatLinks()
    ])
    return { devices, links }
  }, [client])

  // The list, and again every few seconds while it is open, so a new
  // device's request shows up without a reload.
  useEffect(() => {
    if (record == null) return
    let live = true
    const read = (): void => {
      load()
        .then(next => {
          if (live) setListing(next)
        })
        .catch(() => {
          // A missed read keeps what is showing; only a first one fails.
          if (live)
            setListing(current => {
              if (current == null) setFailed(true)
              return current
            })
        })
    }
    read()
    const timer = setInterval(read, pollMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [load, pollMs, record, approvals.state.revision])

  const act = (key: string, work: () => Promise<void>): void => {
    setBusy(key)
    setError(undefined)
    work()
      .then(async () => {
        setListing(await load())
      })
      .catch(() => {
        setError(lstrings.chat_devices_failed)
      })
      .finally(() => {
        setBusy(undefined)
      })
  }

  if (linking) {
    return (
      <LinkDeviceScreen
        client={client}
        userId={userId}
        store={store}
        device={setup.device}
        pollMs={props.pollMs}
        onDone={() => {
          setLinking(false)
          setRound(current => current + 1)
        }}
      />
    )
  }
  if (failed) {
    return (
      <Screen>
        <Text style={styles.error}>{lstrings.chat_devices_cannot_load}</Text>
      </Screen>
    )
  }
  if (record == null || listing == null) {
    return (
      <Screen>
        <Text style={styles.muted}>{lstrings.common_loading}</Text>
      </Screen>
    )
  }

  const own = record.deviceId
  const devices = listing.devices.filter(device => device.revokedAt == null)
  const links = listing.links.filter(link => link.newDevice.id !== own)

  return (
    <Screen>
      <Text style={styles.muted}>{lstrings.chat_devices_intro}</Text>
      {error != null && <Text style={styles.error}>{error}</Text>}

      {links.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title={lstrings.chat_devices_requests} />
          {links.map(link => {
            const code = pendingLinkCode(link)
            return (
              <Card key={link.id} style={styles.request}>
                <Text style={styles.heading}>
                  {sprintf(lstrings.chat_devices_request, link.newDevice.name)}
                </Text>
                <Text style={styles.muted}>
                  {platformName(link.newDevice)} ·{' '}
                  {new Date(link.createdAt).toLocaleString()}
                </Text>
                <Text
                  style={styles.code}
                  accessibilityLabel={sprintf(
                    lstrings.chat_devices_code_label,
                    code
                  )}
                >
                  {spacedCode(code)}
                </Text>
                <Text style={styles.muted}>
                  {sprintf(
                    lstrings.chat_devices_request_detail,
                    link.newDevice.name
                  )}
                </Text>
                {approvals.controller != null ? (
                  <DeviceApprovalActions id={link.id} showCode={false} />
                ) : (
                  <View style={styles.actions}>
                    <Button
                      label={lstrings.chat_devices_approve}
                      accessibilityLabel={sprintf(
                        lstrings.chat_devices_approve_label,
                        link.newDevice.name
                      )}
                      kind="primary"
                      busy={busy === link.id}
                      disabled={busy != null}
                      onPress={() => {
                        act(link.id, async () => {
                          await approveLink(setup, record, link)
                        })
                      }}
                    />
                    <Button
                      label={lstrings.chat_devices_decline}
                      accessibilityLabel={sprintf(
                        lstrings.chat_devices_decline_label,
                        link.newDevice.name
                      )}
                      kind="text"
                      disabled={busy != null}
                      onPress={() => {
                        act(link.id, async () => {
                          await client.declineChatLink(link.id)
                        })
                      }}
                    />
                  </View>
                )}
              </Card>
            )
          })}
        </View>
      )}

      <View style={styles.section}>
        <SectionHeader
          title={lstrings.chat_devices_list}
          note={String(devices.length)}
        />
        <Card>
          {devices.map((device, index) => {
            const mine = device.id === own
            return (
              <View key={device.id}>
                {index > 0 && <View style={styles.divider} />}
                <View style={styles.deviceRow}>
                  <View style={styles.deviceName}>
                    <ListRow
                      title={
                        mine
                          ? sprintf(lstrings.chat_devices_this, device.name)
                          : device.name
                      }
                      subtitle={`${platformName(device)} · ${
                        device.linked
                          ? lstrings.chat_devices_linked
                          : lstrings.chat_devices_pending
                      }`}
                      emblem={initialsOf(device.name)}
                    />
                  </View>
                  {!mine && (
                    <Button
                      label={lstrings.chat_devices_remove}
                      accessibilityLabel={sprintf(
                        lstrings.chat_devices_remove_label,
                        device.name
                      )}
                      kind="secondary"
                      compact
                      busy={busy === device.id}
                      disabled={busy != null}
                      onPress={() => {
                        act(device.id, async () => {
                          setRecord(
                            await revokeOtherDevice(setup, record, device.id)
                          )
                        })
                      }}
                    />
                  )}
                </View>
              </View>
            )
          })}
        </Card>
      </View>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  request: {
    gap: theme.rem(theme.spaceSmRem)
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  deviceName: {
    flex: 1
  },
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor
  },
  heading: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  code: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(2),
    fontWeight: '700',
    letterSpacing: theme.rem(0.2),
    color: theme.primaryTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
