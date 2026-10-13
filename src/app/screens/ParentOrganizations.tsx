import React, { useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { PublicGroup } from '../../common/publicGroups'
import {
  Badge,
  Card,
  DangerText,
  Emblem,
  initialsOf,
  SectionHeader
} from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
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
      <Card style={styles.card}>
        {parents.map(parent => (
          <View key={`${parent.kind}:${parent.id}`} style={styles.row}>
            <Emblem uri={parent.imageUrl} fallback={initialsOf(parent.name)} />
            <View style={styles.words}>
              <Text style={styles.name}>{parent.name}</Text>
              <Badge label={parent.kind === 'league' ? 'League' : 'Season'} />
            </View>
            <DangerText
              label="Leave"
              accessibilityLabel={`Leave ${parent.name}`}
              disabled={breaker.busy}
              onPress={() => {
                setSelected(parent)
                breaker.review(
                  { kind: 'team', id: teamId },
                  { kind: parent.kind, id: parent.id }
                )
              }}
            />
          </View>
        ))}
      </Card>
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
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75)
  },
  words: { flex: 1, gap: theme.rem(0.25) },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.0625),
    color: theme.primaryTextColor
  },
  error: { color: theme.dangerColor }
}))
