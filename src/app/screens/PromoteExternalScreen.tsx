import React, { useRef, useState } from 'react'
import { Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button, Card, Screen, TextField } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function PromoteExternalScreen({
  client,
  teamId,
  onSent,
  onCancel
}: {
  client: TeamStationClient
  teamId: string
  onSent: (id: string) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const attempt = useRef<{ email: string; key: string } | undefined>(undefined)
  const send = async (): Promise<void> => {
    if (busy) return
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
        idempotencyKey: attempt.current.key
      })
      onSent(result.id)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The administrator invitation could not be sent. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Screen>
      <Card style={styles.card}>
        <Text style={styles.title}>Invite team administrator</Text>
        <Text style={styles.hint}>
          Invite a person who has signed in and verified their email. Their
          acceptance makes this placeholder team a full TeamStation team with
          its existing name, location, identity and game history. Parent
          organizations and competition memberships stay unchanged.
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
          label="Send administrator invitation"
          busy={busy}
          disabled={email.trim() === ''}
          onPress={() => {
            send().catch(() => undefined)
          }}
        />
        <Button
          label="Cancel"
          kind="secondary"
          disabled={busy}
          onPress={onCancel}
        />
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
