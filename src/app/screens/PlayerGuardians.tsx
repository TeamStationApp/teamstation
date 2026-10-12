import React, { useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button, Card, TextField } from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** A retry key: one per send, kept while that send is retried. */
const retryKey = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`

export interface GuardianInviteProps {
  client: TeamStationClient
  /**
   * The team the page was opened for, which sends a staff member's
   * invitation. Absent for a guardian's, which goes out in their own name.
   */
  teamId?: string
  playerUserId: number
  /** The player's short name, for the sentence that says what a guardian is. */
  playerName: string
}

/**
 * The Settings row a player's guardian, or a team's admin, coach or
 * assistant while the player has no guardian, invites a guardian from: an
 * address and a button.
 *
 * A staff member's invitation is the team's, so it goes out from the team
 * the page was opened for; a guardian's has no team, and goes out in their
 * own name. The person accepts it from their notifications, or from the
 * link mailed to the address; an address nobody has yet waits for whoever
 * verifies it. Each send has a retry key of its own, and a send that failed
 * is retried under the same one, so a slow network never sends two.
 */
export function GuardianInvite(props: GuardianInviteProps): React.ReactElement {
  const { client, teamId, playerUserId, playerName } = props
  const styles = getStyles(useTheme())
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined)

  const send = async (): Promise<void> => {
    const wanted = email.trim()
    if (busy || wanted === '') return
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    const fields = {
      kind: 'guardian' as const,
      playerUserId,
      guardian: { email: wanted.toLowerCase() },
      ...(teamId == null
        ? {}
        : { sender: { kind: 'team' as const, id: teamId } })
    }
    const body = JSON.stringify(fields)
    if (attempt.current?.body !== body)
      attempt.current = { body, key: retryKey('guardian') }
    try {
      await client.inviteRelationship({
        ...fields,
        idempotencyKey: attempt.current.key
      })
      attempt.current = undefined
      setNote(sprintf(lstrings.manage_invited, wanted))
      setEmail('')
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : lstrings.player_guardian_cannot_send
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card style={styles.form}>
      <Text style={styles.title}>{lstrings.player_guardian_invite}</Text>
      <Text style={styles.muted}>
        {sprintf(lstrings.player_guardian_invite_detail, playerName)}
      </Text>
      <TextField
        label={lstrings.player_guardian_email}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        onSubmitEditing={() => {
          send().catch(() => undefined)
        }}
      />
      {error != null && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {note != null && <Text style={styles.muted}>{note}</Text>}
      <Button
        label={lstrings.player_guardian_send}
        busy={busy}
        disabled={email.trim() === ''}
        onPress={() => {
          send().catch(() => undefined)
        }}
      />
    </Card>
  )
}

export interface GuardianRequestProps {
  client: TeamStationClient
  playerUserId: number
  /** The player's short name, for the question the sheet asks. */
  playerName: string
  /** The signed-in viewer, who asks for themselves. */
  viewerId: number
}

/**
 * "Request to be a guardian", under a player's name, for somebody signed in
 * who can see the player and has no say over them yet.
 *
 * A sheet asks first, because the request goes to the player, their
 * guardians or, while they have none, their coaches, and cannot be taken
 * back from here. Sent, the button says so and
 * does nothing more. A refusal — five requests already waiting, or three
 * declined in a row — is shown as the server words it, since only it knows
 * the date the block ends.
 */
export function GuardianRequest(
  props: GuardianRequestProps
): React.ReactElement {
  const { client, playerUserId, playerName, viewerId } = props
  const styles = getStyles(useTheme())
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const attempt = useRef<string | undefined>(undefined)

  const send = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    attempt.current ??= retryKey('guardian-request')
    try {
      await client.inviteRelationship({
        kind: 'guardian',
        playerUserId,
        guardian: { userId: viewerId },
        idempotencyKey: attempt.current
      })
      attempt.current = undefined
      setSent(true)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : lstrings.player_guardian_cannot_request
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.request}>
      <View style={styles.requestButton}>
        <Button
          label={
            sent
              ? lstrings.player_guardian_request_sent
              : lstrings.player_guardian_request
          }
          kind="secondary"
          compact
          busy={busy}
          disabled={sent}
          onPress={() => {
            setAsking(true)
          }}
        />
      </View>
      {error != null && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {asking && (
        <ChoiceSheet
          title={sprintf(lstrings.player_guardian_request_title, playerName)}
          choices={[
            {
              label: lstrings.player_guardian_request_send,
              detail: sprintf(
                lstrings.player_guardian_request_detail,
                playerName
              ),
              onPress: () => {
                send().catch(() => undefined)
              }
            }
          ]}
          onClose={() => {
            setAsking(false)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  form: {
    gap: theme.rem(theme.spaceMdRem)
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  request: {
    gap: theme.rem(theme.spaceXsRem),
    marginTop: theme.rem(theme.spaceXsRem)
  },
  requestButton: {
    flexDirection: 'row'
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
