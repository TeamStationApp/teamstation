import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { Invite, TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import {
  Button,
  Card,
  DangerText,
  Icon,
  Screen,
  TextField
} from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import { CancelAction } from '../components/CancelAction'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { lstrings, sprintf } from '../locales/strings'
import { copyToClipboard } from '../platform/clipboard'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function InviteSpectatorsScreen({
  client,
  group,
  scopeName
}: {
  client: TeamStationClient
  group: GroupRef
  scopeName: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [invites, setInvites] = useState<Invite[]>([])
  const [allowed, setAllowed] = useState<boolean>()
  const [opening, setOpening] = useState(false)
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [copied, setCopied] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const begin = useLatestRequest()
  const beginWrite = useLatestRequest()
  const confirmation = useConfirmedAction(
    client,
    `${group.kind}:${group.id}:${allowed}:${invites.map(i => `${i.id}:${i.problem ?? ''}`).join(',')}`
  )
  const working = useRef(false)
  useEffect(() => {
    setAllowed(undefined)
    setInvites([])
    setOpening(false)
    setCode('')
    setLabel('')
    setCopied('')
    setBusy(false)
    working.current = false
    beginWrite()
  }, [client, group.kind, group.id, beginWrite])
  useEffect(() => {
    const current = begin()
    client.invites(group.kind, group.id).then(
      value => {
        if (current()) {
          setInvites(value.invites)
          setAllowed(value.canInvite)
          setError('')
        }
      },
      () => {
        if (current()) setError('Invite links could not load. Try again.')
      }
    )
  }, [client, group.kind, group.id, revision, begin])
  const run = async (
    operation: (current: () => boolean) => Promise<void>
  ): Promise<void> => {
    if (working.current) return
    working.current = true
    const current = beginWrite()
    setBusy(true)
    setError('')
    try {
      await operation(current)
      if (current()) setRevision(value => value + 1)
    } catch (error) {
      if (current())
        setError(
          error instanceof Error
            ? error.message
            : 'Invite link could not be changed. Try again.'
        )
    } finally {
      if (current()) {
        working.current = false
        setBusy(false)
      }
    }
  }
  const create = (): void => {
    run(async current => {
      await client.createInvite({
        scopeType: group.kind,
        scopeId: group.id,
        code: code.trim() === '' ? undefined : code.trim(),
        label: label.trim() === '' ? undefined : label.trim()
      })
      if (current()) {
        setOpening(false)
        setCode('')
        setLabel('')
      }
    }).catch(() => undefined)
  }
  const live = invites
    .filter(invite => invite.problem == null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Invite Spectators
        </Text>
        {allowed === false ? (
          <Text style={styles.hint}>
            Only an administrator can make invite links.
          </Text>
        ) : (
          <>
            <Text style={styles.hint}>
              {sprintf(lstrings.invite_detail, scopeName)}
            </Text>
            {allowed === undefined && error === '' && (
              <Text style={styles.hint}>Loading…</Text>
            )}
            {allowed === true && (
              <>
                {live.length === 0 && (
                  <Text style={styles.hint}>No invite links yet.</Text>
                )}
                <ActionList>
                  {live.map(invite => (
                    <ActionRow
                      key={invite.id}
                      title={invite.label ?? invite.code}
                      detail={[
                        invite.url,
                        invite.uses === 0
                          ? 'Never used'
                          : invite.uses === 1
                            ? 'Used once'
                            : `Used ${invite.uses} times`,
                        invite.label,
                        copied === invite.id ? 'Copied' : null
                      ]
                        .filter(value => value != null && value !== '')
                        .join(' · ')}
                      leading={<Icon name="content_copy" size={1.25} />}
                      onOpen={() => {
                        copyToClipboard(invite.url)
                        setCopied(invite.id)
                      }}
                      openLabel={`Copy the invite link ${invite.code}`}
                      end={
                        <DangerText
                          label="Disable"
                          accessibilityLabel={`Disable invite link ${invite.label ?? invite.code}`}
                          disabled={busy || confirmation.busy}
                          style={{ minWidth: 48, alignItems: 'center' }}
                          onPress={() => {
                            confirmation.open({
                              title: `Disable ${invite.label ?? invite.code} for ${scopeName}?`,
                              detail:
                                'This link will no longer let people join. Existing members keep their access.',
                              label: 'Disable',
                              accessibilityLabel: 'Confirm disable',
                              run: async current => {
                                await client.revokeInvite(invite.id)
                                if (current()) setRevision(value => value + 1)
                              }
                            })
                          }}
                        />
                      }
                    />
                  ))}
                </ActionList>
                {confirmation.sheet}
                {opening ? (
                  <Card style={styles.card}>
                    <TextField
                      label="Invite code"
                      value={code}
                      onChangeText={setCode}
                      disabled={busy}
                    />
                    <TextField
                      label="Label"
                      value={label}
                      onChangeText={setLabel}
                      disabled={busy}
                    />
                    <Button label="Create" block busy={busy} onPress={create} />
                    <CancelAction
                      label="Cancel"
                      disabled={busy}
                      onPress={() => {
                        setOpening(false)
                      }}
                    />
                  </Card>
                ) : (
                  <Button
                    label="Create invite link"
                    kind="secondary"
                    onPress={() => {
                      setOpening(true)
                    }}
                  />
                )}
              </>
            )}
          </>
        )}
        {error !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry"
              onPress={() => {
                setRevision(value => value + 1)
              }}
            />
          </>
        )}
      </View>
    </Screen>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1) },
  card: { gap: theme.rem(0.75) },
  title: {
    fontSize: theme.rem(1.5),
    fontFamily: theme.semiBoldTextFont,
    color: theme.primaryTextColor
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75),
    minHeight: 64
  },
  words: { flex: 1 },
  link: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.5),
    minHeight: 32
  },
  url: { flex: 1, fontSize: theme.rem(0.875), color: theme.activeColor },
  hint: { fontSize: theme.rem(0.8125), color: theme.secondaryTextColor },
  error: { color: theme.dangerColor }
}))
