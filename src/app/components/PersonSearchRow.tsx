import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { PersonAffiliationLine } from './PersonAffiliationLine'
import { PersonEmblem } from './PersonEmblem'

/** A person identity shared by account and umpire candidate searches. */
export function PersonSearchRow({
  userId,
  name,
  avatarUrl,
  affiliations,
  onPress,
  disabled,
  accessibilityLabel = name,
  affiliationTestID
}: {
  userId: string
  name: string
  avatarUrl?: string | null
  affiliations?: string
  onPress: () => void
  disabled?: boolean
  accessibilityLabel?: string
  affiliationTestID?: string
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={styles.row}
    >
      <PersonEmblem
        userId={userId}
        name={name}
        uri={avatarUrl}
        initialsSize={0.875}
      />
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        <PersonAffiliationLine
          affiliations={affiliations}
          testID={affiliationTestID}
        />
      </View>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    minHeight: 48,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(theme.spaceMdRem),
    padding: theme.rem(theme.cardContentInsetRem)
  },
  text: { flex: 1, minWidth: 0, gap: theme.rem(0.125) },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.primaryTextColor
  }
}))
