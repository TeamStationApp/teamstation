import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { UndoTicker } from '../scoring/UndoTicker'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Emblem } from './Emblem'
import { initialsOf } from './initials'

/** A person identity shared by account and umpire candidate searches. */
export function PersonSearchRow({
  name,
  avatarUrl,
  affiliations,
  onPress,
  disabled,
  accessibilityLabel = name,
  affiliationTestID
}: {
  name: string
  avatarUrl?: string | null
  affiliations?: string
  onPress: () => void
  disabled?: boolean
  accessibilityLabel?: string
  affiliationTestID?: string
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const initials = initialsOf(name)
  const letters =
    initials.length === 1
      ? Array.from(name.trim().replace(/^[^\p{L}\p{N}]+/u, ''))
          .slice(0, 2)
          .join('')
          .toUpperCase()
      : initials
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={styles.row}
    >
      <Emblem
        uri={avatarUrl}
        fallback={letters}
        initialsSize={0.875}
        shape="circle"
      />
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        {affiliations != null && affiliations !== '' && (
          <UndoTicker
            text={affiliations}
            style={styles.affiliation}
            enabled
            testID={affiliationTestID}
          />
        )}
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
  },
  affiliation: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
