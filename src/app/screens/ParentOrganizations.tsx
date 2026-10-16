import React, { useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { PublicGroup } from '../../common/publicGroups'
import { SectionHeader } from '../components'
import { ActionList } from '../components/ActionRow'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { GroupRelationshipRow } from './GroupRelationshipRow'
import { useBreakParent } from './useBreakParent'

export function ParentOrganizations({
  client,
  teamId,
  teamName,
  parents,
  onLeft
}: {
  client: TeamStationClient
  teamId: string
  teamName: string
  parents: PublicGroup[]
  onLeft: () => void
}): React.ReactElement | null {
  const styles = getStyles(useTheme())
  const [selected, setSelected] = useState<PublicGroup>()
  const parentName = selected?.name ?? ''
  const breaker = useBreakParent(client, onLeft, {
    title: `Leave ${parentName}?`,
    warning: `Administrators of ${parentName} will no longer manage ${teamName}: they lose access to its settings, people and games through ${parentName}.`,
    confirmLabel: `Leave ${parentName}`,
    cancelLabel: 'Cancel',
    danger: true
  })
  if (parents.length === 0) return null
  return (
    <View style={styles.section}>
      <SectionHeader title="Parent Organizations" />
      <ActionList bounded>
        {parents.map(parent => (
          <GroupRelationshipRow
            key={`${parent.kind}:${parent.id}`}
            group={parent}
            label={`Leave ${parent.name}`}
            disabled={breaker.busy}
            onLeave={() => {
              setSelected(parent)
              breaker.review(
                { kind: 'team', id: teamId },
                { kind: parent.kind, id: parent.id }
              )
            }}
          />
        ))}
      </ActionList>
      {breaker.error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {breaker.error}
        </Text>
      )}
      {breaker.sheet}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(0.75) },
  error: { color: theme.dangerColor }
}))
