import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { ManagePage, TeamStationClient } from '../../common/api'
import { Button, Card, DangerText, SectionHeader } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { calendarDate } from './format'
import { ManagePlayers } from './ManagePlayers'

export function InvitationsWaiting({
  client,
  scopeKind,
  scopeId,
  onChanged
}: {
  client: TeamStationClient
  scopeKind: 'team' | 'season' | 'league'
  scopeId: string
  onChanged?: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [page, setPage] = useState<ManagePage>()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resent, setResent] = useState('')
  const begin = useLatestRequest()
  const working = useRef(false)
  const keys = useRef(new Map<string, string>())
  useEffect(() => {
    const current = begin()
    client.managePage(scopeKind, scopeId).then(
      value => {
        if (current()) {
          setPage(value)
          setError('')
        }
      },
      () => {
        if (current()) setError('People could not load. Try again.')
      }
    )
  }, [client, scopeKind, scopeId, revision, begin])
  const refresh = (): void => {
    setRevision(value => value + 1)
    onChanged?.()
  }
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
      refresh()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Invitation could not be changed. Try again.'
      )
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  return (
    <View style={styles.page}>
      {page != null && (
        <>
          {page.pending.length > 0 && (
            <View style={styles.section}>
              <SectionHeader
                title="Invitations waiting"
                note={String(page.pending.length)}
              />
              <Card style={styles.card}>
                {page.pending.map(invite => (
                  <View key={invite.inviteId} style={styles.invitation}>
                    <View style={styles.top}>
                      <Text style={styles.email}>{invite.email}</Text>
                      {invite.requestId != null && (
                        <Button
                          label="Resend"
                          kind="text"
                          compact
                          disabled={busy}
                          onPress={() => {
                            run(async () => {
                              let key = keys.current.get(invite.requestId!)
                              if (key == null) {
                                key = `resend-${Date.now()}-${Math.random().toString(36).slice(2)}`
                                keys.current.set(invite.requestId!, key)
                              }
                              await client.decideRelationship(
                                invite.requestId!,
                                'resend',
                                key
                              )
                              setResent(invite.email)
                            }).catch(() => undefined)
                          }}
                        />
                      )}
                    </View>
                    <Text style={styles.hint}>
                      Invited {calendarDate(invite.invitedAt)}, not joined yet
                    </Text>
                    {resent === invite.email && (
                      <Text style={styles.hint}>Sent again</Text>
                    )}
                    <DangerText
                      label="Withdraw invitation"
                      disabled={busy}
                      onPress={() => {
                        run(async () => {
                          await client.revokeInvite(invite.inviteId)
                        }).catch(() => undefined)
                      }}
                    />
                  </View>
                ))}
              </Card>
            </View>
          )}
          {scopeKind === 'team' && (
            <ManagePlayers
              client={client}
              teamId={scopeId}
              teamName={page.scope.name}
              people={page.people}
              onChanged={refresh}
            />
          )}
        </>
      )}
      {error !== '' && (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button
            label="Retry people"
            onPress={() => {
              setRevision(value => value + 1)
            }}
          />
        </>
      )}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(1) },
  invitation: { gap: theme.rem(0.25) },
  top: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: theme.rem(0.5)
  },
  email: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    color: theme.primaryTextColor
  },
  hint: { fontSize: theme.rem(0.8125), color: theme.secondaryTextColor },
  error: { color: theme.dangerColor }
}))
