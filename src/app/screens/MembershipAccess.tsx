import React, { useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button } from '../components/Button'
import { RadioMark } from '../components/RadioMark'
import { WarningSheet } from '../components/WarningSheet'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'

/** A request is explicit and names one team; it never grants access itself. */
export function MembershipAccess({
  client,
  signedIn,
  teams,
  onSignIn,
  onClose,
  presentation = 'inline',
  resource = 'stats'
}: {
  client: TeamStationClient
  signedIn: boolean
  teams: Array<{ id: string; name: string }>
  onSignIn: () => void
  onClose?: () => void
  presentation?: 'inline' | 'sheet'
  resource?: 'stats' | 'videos'
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
      onClose?.()
      onSignIn()
      return
    }
    if (sent) {
      onClose?.()
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
          throw new Error('These teams do not accept membership requests yet.')
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
  const message = sent
    ? 'Membership request sent'
    : resource === 'videos'
      ? lstrings.game_videos_members_only
      : teams.length === 1
        ? 'You need to be a member of this team to see individual player stats.'
        : lstrings.box_score_members_only
  const detail =
    error ??
    (sent
      ? `A team administrator will review your request. ${resource === 'videos' ? 'Videos' : 'Individual player stats'} become available after approval.`
      : !signedIn
        ? 'Log in or create an account first to request membership.'
        : choices != null
          ? 'Choose a team. Its administrators will review your request.'
          : undefined)
  const actionLabel = sent
    ? 'Done'
    : !signedIn
      ? 'Log in / Sign up'
      : choices == null
        ? 'Request membership'
        : 'Send request'
  const onAction = (): void => {
    action().catch(() => undefined)
  }
  const choicesView =
    !sent &&
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
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.rem(0.75),
          borderBottomWidth: 1,
          borderBottomColor:
            presentation === 'sheet' ? '#806100' : theme.secondaryTextColor
        }}
      >
        <Text
          style={{
            flex: 1,
            color:
              presentation === 'sheet' ? '#211B00' : theme.primaryTextColor,
            fontFamily: theme.semiBoldTextFont,
            fontSize: theme.rem(1)
          }}
        >
          {team.name}
        </Text>
        <RadioMark on={selected === team.id} />
      </Pressable>
    ))
  if (presentation === 'sheet')
    return (
      <WarningSheet
        message={message}
        detail={detail}
        actionLabel={actionLabel}
        onAction={onAction}
        onClose={() => onClose?.()}
        busy={busy}
      >
        {choicesView}
      </WarningSheet>
    )
  return (
    <View
      testID="statsMembershipAccess"
      style={{ gap: theme.rem(1), padding: theme.rem(1) }}
    >
      <Text
        accessibilityRole="alert"
        style={{
          color: theme.primaryTextColor,
          fontFamily: theme.semiBoldTextFont,
          fontSize: theme.rem(1.125),
          textAlign: 'center'
        }}
      >
        {message}
      </Text>
      {detail != null && (
        <Text
          style={{
            color: theme.primaryTextColor,
            fontFamily: theme.regularTextFont,
            fontSize: theme.rem(1),
            textAlign: 'center'
          }}
        >
          {detail}
        </Text>
      )}
      {choicesView}
      {!sent && (
        <Button
          label={actionLabel}
          onPress={onAction}
          busy={busy}
          color="#1565C0"
          textColor="#FFFFFF"
          style={{ alignSelf: 'center' }}
        />
      )}
    </View>
  )
}
