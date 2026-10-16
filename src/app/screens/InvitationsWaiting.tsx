import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { ManagePage, TeamStationClient } from '../../common/api'
import { Button, DangerText, Emblem, SectionHeader } from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import { useConfirmedAction } from '../components/useConfirmedAction'
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
  const beginWrite = useLatestRequest()
  const working = useRef(false)
  const keys = useRef(new Map<string, string>())
  const confirmation = useConfirmedAction(
    client,
    `${scopeKind}:${scopeId}:${page?.pending.map(p => p.inviteId).join(',') ?? ''}`
  )
  useEffect(() => {
    setPage(undefined)
    setResent('')
    setBusy(false)
    working.current = false
    beginWrite()
    keys.current.clear()
  }, [client, scopeKind, scopeId, beginWrite])
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
  const resend = async (
    invite: ManagePage['pending'][number]
  ): Promise<void> => {
    if (working.current || confirmation.busy || invite.requestId == null) return
    working.current = true
    const current = beginWrite()
    setBusy(true)
    setError('')
    try {
      let key = keys.current.get(invite.requestId)
      if (key == null) {
        key = `resend-${Date.now()}-${Math.random().toString(36).slice(2)}`
        keys.current.set(invite.requestId, key)
      }
      await client.decideRelationship(invite.requestId, 'resend', key)
      if (current()) {
        setResent(invite.email)
        refresh()
      }
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error
            ? caught.message
            : 'Invitation could not be changed. Try again.'
        )
    } finally {
      if (current()) {
        working.current = false
        setBusy(false)
      }
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
              <ActionList>
                {page.pending.map(invite => (
                  <ActionRow
                    key={invite.inviteId}
                    title={invite.email}
                    detail={`Invited ${calendarDate(invite.invitedAt)}, not joined yet${resent === invite.email ? ' · Sent again' : ''}`}
                    leading={<Emblem fallback="" icon="mail" />}
                    end={
                      <View>
                        {invite.requestId != null && (
                          <Button
                            label="Resend"
                            style={{ paddingHorizontal: 0, minWidth: 48 }}
                            accessibilityLabel={`Resend invitation to ${invite.email}`}
                            kind="text"
                            disabled={busy || confirmation.busy}
                            onPress={() => {
                              resend(invite).catch(() => undefined)
                            }}
                          />
                        )}
                        <DangerText
                          label="Withdraw"
                          accessibilityLabel={`Withdraw invitation to ${invite.email}`}
                          disabled={busy || confirmation.busy}
                          style={{ minWidth: 48, alignItems: 'center' }}
                          onPress={() => {
                            confirmation.open({
                              title: `Withdraw invitation to ${invite.email}?`,
                              detail: `They will no longer be able to join ${page.scope.name} using this invitation. Existing memberships stay unchanged.`,
                              label: 'Withdraw',
                              accessibilityLabel: 'Confirm withdrawal',
                              run: async current => {
                                await client.revokeInvite(invite.inviteId)
                                if (current()) refresh()
                              }
                            })
                          }}
                        />
                      </View>
                    }
                  />
                ))}
              </ActionList>
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
      {confirmation.sheet}
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
  error: { color: theme.dangerColor }
}))
