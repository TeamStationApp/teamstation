import React from 'react'
import { View } from 'react-native'

import { localityLabel } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Card } from './Card'
import { initialsOf } from './initials'
import { ListRow } from './ListRow'

/** Home's group row, in its own card for an unbounded search result list. */
export function GroupSearchCard({
  group,
  accessibilityLabel,
  disabled,
  onPress,
  action
}: {
  group: PublicGroup
  accessibilityLabel: string
  disabled?: boolean
  onPress: () => void
  action?: React.ReactNode
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const details = [
    ...(group.parentNames.length === 0
      ? []
      : [`Parents: ${group.parentNames.join(', ')}`]),
    ...(group.locality == null ? [] : [localityLabel(group.locality)]),
    ...(group.kind === 'season'
      ? [seasonPeriodLabel(group.startsOn, group.endsOn)]
      : []),
    ...(group.external ? ['Placeholder team'] : [])
  ].filter(Boolean)
  return (
    <Card flush style={styles.card} testID="group-search-card">
      <View style={styles.identity}>
        <ListRow
          title={group.name}
          teamName={group.kind === 'team' ? group.name : undefined}
          emblem={initialsOf(group.name)}
          emblemUri={group.imageUrl}
          subtitle={details.length === 0 ? undefined : details.join('\n')}
          subtitleNumberOfLines={0}
          accessibilityLabel={accessibilityLabel}
          disabled={disabled}
          onPress={onPress}
        />
      </View>
      {action != null && <View style={styles.action}>{action}</View>}
    </Card>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: { flexDirection: 'row', alignItems: 'center' },
  identity: { flex: 1, minWidth: 0 },
  action: { paddingRight: theme.rem(theme.cardContentInsetRem) }
}))
