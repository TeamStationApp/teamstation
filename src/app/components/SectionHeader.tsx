import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface SectionHeaderProps {
  title: string
  /** A count or a note, set quietly to the right of the title. */
  note?: string
  /** An optional action at the far right, e.g. "Full Schedule →". */
  actionLabel?: string
  onAction?: () => void
}

/**
 * `GAME VIDEO LIBRARY   9 Total Replays` — the small caps rule that separates
 * the stacked sections of a screen.
 *
 * Uppercase with wide tracking, which is the one place the designs were
 * consistent, and it earns its keep: it reads as furniture rather than as
 * content, so a section title is never mistaken for a team name.
 */
export function SectionHeader(props: SectionHeaderProps): React.ReactElement {
  const { title, note, actionLabel, onAction } = props
  const styles = getStyles(useTheme())

  return (
    <View style={styles.row}>
      <Text style={styles.title} numberOfLines={1}>
        {title.toUpperCase()}
      </Text>
      <View style={styles.right}>
        {note != null && <Text style={styles.note}>{note}</Text>}
        {actionLabel != null && onAction != null && (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Text style={styles.action}>{actionLabel}</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    flexShrink: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '700',
    letterSpacing: theme.rem(0.0625),
    color: theme.secondaryTextColor
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor,
    backgroundColor: theme.containerBackgroundColor,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.radiusPill,
    overflow: 'hidden'
  },
  action: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.activeColor
  },
  pressed: {
    opacity: 0.6
  }
}))
