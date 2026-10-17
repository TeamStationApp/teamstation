import React, { useEffect, useRef, useState } from 'react'
import { Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button, Card, Screen, TextField } from '../components'
import { CancelAction } from '../components/CancelAction'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function PromoteExternalScreen({
  client,
  teamId,
  onSent,
  onCancel
}: {
  client: TeamStationClient
  teamId: string
  onSent: (id: string, result?: { status: string; message: string }) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ownEmails, setOwnEmails] = useState<string[]>([])
  const [teamName, setTeamName] = useState('Team')
  const begin = useLatestRequest()
  const working = useRef(false)
  useEffect(() => {
    const current = begin()
    setOwnEmails([])
    setTeamName('Team')
    setEmail('')
    setError('')
    setBusy(false)
    Promise.all([
      client.accountSettings(),
      client.group({ kind: 'team', id: teamId })
    ])
      .then(([account, detail]) => {
        if (!current()) return
        setTeamName(detail.group.name)
        if (detail.canManage)
          setOwnEmails(
            account.emails
              .filter(row => row.isVerified === true)
              .map(row => row.email.toLowerCase())
          )
      })
      .catch(() => {
        // Unknown rights retain the invitation label; the server checks the write.
      })
  }, [client, teamId, begin])
  const immediate = ownEmails.includes(email.trim().toLowerCase())
  const attempt = useRef<{ email: string; key: string } | undefined>(undefined)
  const send = async (): Promise<void> => {
    if (busy || working.current) return
    working.current = true
    const current = begin()
    setBusy(true)
    setError('')
    if (attempt.current?.email !== email)
      attempt.current = {
        email,
        key: `promote-${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    try {
      const result = await client.inviteRelationship({
        kind: 'promotion',
        teamId,
        recipientEmail: email,
        sender: { kind: 'team', id: teamId },
        confirmBoth: immediate,
        idempotencyKey: attempt.current.key
      })
      if (current())
        onSent(result.id, {
          status: result.status,
          message: `${teamName}: administrator added (${email.trim()})`
        })
    } catch (error) {
      if (!current()) return
      setError(
        error instanceof Error
          ? error.message
          : 'The administrator invitation could not be sent. Retry.'
      )
    } finally {
      working.current = false
      if (current()) setBusy(false)
    }
  }
  return (
    <Screen>
      <Card style={styles.card}>
        <Text style={styles.title}>
          {immediate ? 'Add team administrator' : 'Invite team administrator'}
        </Text>
        <Text style={styles.hint}>
          {immediate
            ? 'Save makes this placeholder a full TeamStation team and adds you as its administrator. Its name, location, identity and game history stay unchanged.'
            : 'Invite a person who has signed in and verified their email. Their acceptance makes this placeholder team a full TeamStation team with its existing name, location, identity and game history.'}{' '}
          Parent organizations and competition memberships stay unchanged.
        </Text>
        <TextField
          label="Administrator email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
        />
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Button
          label={immediate ? 'Save' : 'Send administrator invitation'}
          busy={busy}
          disabled={email.trim() === ''}
          onPress={() => {
            send().catch(() => undefined)
          }}
        />
        <CancelAction label="Cancel" disabled={busy} onPress={onCancel} />
      </Card>
    </Screen>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  card: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
