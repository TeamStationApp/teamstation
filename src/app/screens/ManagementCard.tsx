import React from 'react'
import { Text, View } from 'react-native'

import type { GroupRef } from '../../common/groupCreation'
import type { GroupDetail } from '../../common/publicGroups'
import { ListCard, ListRow, SectionHeader } from '../components'
import { useTheme } from '../theme/ThemeContext'

export interface ManagementCardProps {
  detail: GroupDetail
  disabled?: boolean
  onAddPeople?: (group: GroupRef) => void
  onInvites?: (group: GroupRef) => void
  onPromote?: (group: GroupRef) => void
}
export function ManagementCard({
  detail,
  disabled = false,
  onAddPeople,
  onInvites,
  onPromote
}: ManagementCardProps): React.ReactElement | null {
  const theme = useTheme()
  if (!detail.canManage) return null
  const ref = { kind: detail.group.kind, id: detail.group.id }
  const noun = `${ref.kind[0].toUpperCase()}${ref.kind.slice(1)}`
  return (
    <View style={{ gap: theme.rem(0.75) }}>
      <SectionHeader title={`${noun} management`} />
      {detail.custodian != null && (
        <Text style={{ color: theme.secondaryTextColor }}>
          Managed by {detail.custodian.name}
        </Text>
      )}
      <ListCard>
        {detail.group.external ? (
          <ListRow
            title="Invite team administrator"
            onPress={
              disabled || onPromote == null
                ? undefined
                : () => {
                    onPromote(ref)
                  }
            }
          />
        ) : (
          <>
            <ListRow
              title={`Add Person to ${noun}`}
              onPress={
                disabled || onAddPeople == null
                  ? undefined
                  : () => {
                      onAddPeople(ref)
                    }
              }
            />
            <ListRow
              title="Create Invite Link"
              onPress={
                disabled || onInvites == null
                  ? undefined
                  : () => {
                      onInvites(ref)
                    }
              }
            />
          </>
        )}
      </ListCard>
    </View>
  )
}
