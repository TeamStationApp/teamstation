import React, { useRef, useState } from 'react'
import { Pressable, Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { WarningSheet } from '../components/WarningSheet'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'

/** A request is explicit and names one team; it never grants access itself. */
export function VideoMembershipSheet({
  client,
  signedIn,
  teams,
  onSignIn,
  onClose
}: {
  client: TeamStationClient
  signedIn: boolean
  teams: Array<{ id: string; name: string }>
  onSignIn: () => void
  onClose: () => void
}): React.ReactElement {
  const theme = useTheme()
  const [choices, setChoices] = useState<typeof teams>()
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string>()
  const keys = useRef(new Map<string, string>())
  const action = async (): Promise<void> => {
    if (!signedIn) {
      onClose()
      onSignIn()
      return
    }
    if (sent) {
      onClose()
      return
    }
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      if (choices == null) {
        const groups = await Promise.all(
          teams.map(async team => ({
            team,
            detail: await client.group({ kind: 'team', id: team.id })
          }))
        )
        const available = groups
          .filter(group => !group.detail.group.external)
          .map(group => group.team)
        if (available.length === 0)
          throw new Error('Neither team accepts membership requests yet.')
        setChoices(available)
        if (available.length === 1) setSelected(available[0].id)
        return
      }
      if (selected == null) {
        setError('Choose the team you want to join.')
        return
      }
      let key = keys.current.get(selected)
      if (key == null) {
        key = `membership-${Date.now()}-${Math.random().toString(36).slice(2)}`
        keys.current.set(selected, key)
      }
      await client.inviteRelationship({
        kind: 'membership',
        teamId: selected,
        idempotencyKey: key
      })
      setSent(true)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The request could not be sent. Please try again.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <WarningSheet
      message={
        sent ? 'Membership request sent' : lstrings.game_videos_members_only
      }
      detail={
        error ??
        (sent
          ? 'A team administrator will review your request. Videos become available after approval.'
          : !signedIn
            ? 'Log in or create an account first to request membership.'
            : choices != null
              ? 'Choose a team. Its administrators will review your request.'
              : undefined)
      }
      actionLabel={
        sent
          ? 'Done'
          : !signedIn
            ? 'Log in / Sign up'
            : choices == null
              ? 'Request membership'
              : 'Send request'
      }
      onAction={() => {
        action().catch(() => undefined)
      }}
      onClose={onClose}
      busy={busy}
    >
      {!sent &&
        choices?.map(team => (
          <Pressable
            key={team.id}
            accessibilityRole="radio"
            accessibilityLabel={team.name}
            accessibilityState={{ checked: selected === team.id }}
            disabled={busy}
            onPress={() => {
              setSelected(team.id)
            }}
            style={{
              padding: theme.rem(0.75),
              marginTop: theme.rem(0.75),
              borderRadius: theme.rem(theme.radiusRem),
              backgroundColor: selected === team.id ? '#FFF3C4' : 'transparent',
              borderWidth: 1,
              borderColor: '#806100'
            }}
          >
            <Text
              style={{
                color: '#211B00',
                fontFamily: theme.semiBoldTextFont,
                fontSize: theme.rem(1)
              }}
            >
              {selected === team.id ? '● ' : '○ '}
              {team.name}
            </Text>
          </Pressable>
        ))}
    </WarningSheet>
  )
}
