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
  /** Add Player: a team's roster manager puts an existing player on it. */
  onAddPlayer?: (teamId: string) => void
  /** Create Player: a team's roster manager makes a new player on it. */
  onCreatePlayer?: (teamId: string) => void
}

/**
 * Team management. An administrator adds people and makes invite links; a
 * team's roster manager (its administrators, coaches, assistants and
 * scorekeepers) adds and creates its players, which is all a roster
 * manager who is not an administrator sees here.
 */
export function ManagementCard({
  detail,
  disabled = false,
  onAddPeople,
  onInvites,
  onPromote,
  onAddPlayer,
  onCreatePlayer
}: ManagementCardProps): React.ReactElement | null {
  const theme = useTheme()
  const ref = { kind: detail.group.kind, id: detail.group.id }
  const players =
    ref.kind === 'team' && !detail.group.external && detail.canManageRoster
  if (!detail.canManage && !players) return null
  const playerRow = (
    title: string,
    open: ((teamId: string) => void) | undefined
  ): React.ReactElement => (
    <ListRow
      title={title}
      onPress={
        disabled || open == null
          ? undefined
          : () => {
              open(ref.id)
            }
      }
    />
  )
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
            {detail.canManage && (
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
            {players && (
              <>
                {playerRow('Add Player', onAddPlayer)}
                {playerRow('Create Player', onCreatePlayer)}
              </>
            )}
          </>
        )}
      </ListCard>
    </View>
  )
}
