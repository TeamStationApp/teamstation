import React from 'react'
import { View } from 'react-native'

import { localityLabel } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import { Button, DangerText, Emblem, initialsOf } from '../components'
import { ActionRow } from '../components/ActionRow'
import { TeamEmblem } from '../components/TeamEmblem'

export function GroupRelationshipRow({
  group,
  label,
  disabled,
  onLeave,
  onOpen,
  action = 'Leave',
  detail,
  links
}: {
  group: Pick<PublicGroup, 'id' | 'kind' | 'name' | 'imageUrl'>
  label?: string
  action?: string
  detail?: string
  links?: Array<{ label: string; onPress: () => void }>
  disabled?: boolean
  onLeave?: () => void
  onOpen?: () => void
}): React.ReactElement {
  return (
    <ActionRow
      title={group.name}
      detail={
        detail ??
        (group.kind === 'league'
          ? 'League'
          : group.kind === 'season'
            ? 'Season'
            : undefined)
      }
      leading={
        group.kind === 'team' ? (
          <TeamEmblem name={group.name} uri={group.imageUrl} />
        ) : (
          <Emblem uri={group.imageUrl} fallback={initialsOf(group.name)} />
        )
      }
      onOpen={onOpen}
      extra={
        links == null || links.length === 0 ? undefined : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {links.map(link => (
              <Button
                key={link.label}
                label={link.label}
                accessibilityLabel={`Open ${link.label}`}
                kind="text"
                small
                onPress={() => {
                  link.onPress()
                }}
              />
            ))}
          </View>
        )
      }
      end={
        onLeave == null ? undefined : (
          <DangerText
            label={action}
            accessibilityLabel={label}
            disabled={disabled}
            onPress={onLeave}
            style={{ minWidth: 48, alignItems: 'center' }}
          />
        )
      }
    />
  )
}
export function relationshipDetails(group: PublicGroup): string | undefined {
  const parts = [
    group.external ? 'Placeholder team' : null,
    group.kind === 'season' && group.startsOn != null && group.endsOn != null
      ? seasonPeriodLabel(group.startsOn, group.endsOn)
      : null,
    ...group.parentNames,
    group.locality == null ? null : localityLabel(group.locality)
  ]
  const details = parts.filter(Boolean).join(' · ')
  return details === '' ? undefined : details
}
