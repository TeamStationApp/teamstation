import React from 'react'
import { Text, View } from 'react-native'

import type { GroupRef } from '../../common/groupCreation'
import type { GroupDetail } from '../../common/publicGroups'
import { Button, SectionHeader } from '../components'
import { useTheme } from '../theme/ThemeContext'
import type { GroupLinkChoice } from './GroupScreen'

export interface TeamSettingsActionsProps {
  detail: GroupDetail
  disabled?: boolean
  onLink: (choice: GroupLinkChoice) => void
  onCreateGame?: (group: GroupRef) => void
  onCreateExternal?: (custodian: GroupRef) => void
  onPromote?: (group: GroupRef) => void
}
/** Team management belongs behind the hero gear, independent of private access. */
export function TeamSettingsActions({
  detail,
  disabled = false,
  onLink,
  onCreateGame,
  onCreateExternal,
  onPromote
}: TeamSettingsActionsProps): React.ReactElement | null {
  const theme = useTheme()
  if (detail.group.kind !== 'team' || !detail.canManage) return null
  const ref: GroupRef = { kind: 'team', id: detail.group.id }
  return (
    <View style={{ gap: theme.rem(0.75) }}>
      <SectionHeader title="Team management" />
      {detail.custodian != null && (
        <Text style={{ color: theme.secondaryTextColor }}>
          Managed by {detail.custodian.name}
        </Text>
      )}
      {!detail.group.external && (
        <Button
          label="Join a Season"
          disabled={disabled}
          kind="secondary"
          onPress={() => {
            onLink({
              subject: ref,
              targetKind: 'season',
              relationship: 'participation',
              direction: 'parents'
            })
          }}
        />
      )}
      {onCreateGame != null && (
        <Button
          label="Create Game"
          disabled={disabled}
          onPress={() => {
            onCreateGame(ref)
          }}
        />
      )}
      {!detail.group.external && onCreateExternal != null && (
        <Button
          label="Create placeholder team"
          disabled={disabled}
          kind="secondary"
          onPress={() => {
            onCreateExternal(ref)
          }}
        />
      )}
      {detail.group.external && onPromote != null && (
        <Button
          label="Invite team administrator"
          disabled={disabled}
          kind="secondary"
          onPress={() => {
            onPromote(ref)
          }}
        />
      )}
    </View>
  )
}
