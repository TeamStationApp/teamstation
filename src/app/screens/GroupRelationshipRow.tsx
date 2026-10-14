import React from 'react'
import { Text, View } from 'react-native'

import type { PublicGroup } from '../../common/publicGroups'
import { Badge, DangerText, Emblem, initialsOf } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function GroupRelationshipRow({
  group,
  label,
  disabled,
  onLeave
}: {
  group: PublicGroup
  label: string
  disabled?: boolean
  onLeave: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.row}>
      <Emblem uri={group.imageUrl} fallback={initialsOf(group.name)} />
      <View style={styles.words}>
        <Text style={styles.name}>{group.name}</Text>
        <Badge label={group.kind === 'league' ? 'League' : 'Season'} />
      </View>
      <DangerText
        label="Leave"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={onLeave}
      />
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
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
  }
}))
