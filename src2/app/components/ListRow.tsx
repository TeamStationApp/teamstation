import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Badge, type BadgeTone } from './Badge'

export interface ListRowProps {
  title: string
  subtitle?: string
  /** A short glyph or initials in the leading tile. */
  emblem?: string
  badgeLabel?: string
  badgeTone?: BadgeTone
  onPress?: () => void
}

/**
 * A team, a season, a player: a leading tile, two lines of text, an optional
 * badge, and a chevron when it opens something.
 *
 * One component rather than three near-identical ones, because the designs drew
 * this row on the home screen, the roster and the league hub with nothing
 * different but the words. The chevron appears only when `onPress` does, so a
 * row that goes nowhere does not advertise that it does.
 */
export function ListRow(props: ListRowProps): React.ReactElement {
  const { title, subtitle, emblem, badgeLabel, badgeTone, onPress } = props
  const styles = getStyles(useTheme())

  const content = (
    <>
      {emblem != null && (
        <View style={styles.emblem}>
          <Text style={styles.emblemText}>{emblem}</Text>
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle != null && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {badgeLabel != null && <Badge label={badgeLabel} tone={badgeTone} />}
      {onPress != null && <Text style={styles.chevron}>›</Text>}
    </>
  )

  if (onPress == null) return <View style={styles.row}>{content}</View>

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle == null ? title : `${title}, ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem),
    minHeight: theme.rem(3.5),
    paddingVertical: theme.rem(theme.spaceSmRem)
  },
  pressed: {
    backgroundColor: theme.highlightRowActiveBackground
  },
  emblem: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.containerBackgroundColor,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emblemText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '700',
    color: theme.activeColor
  },
  text: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  subtitle: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  chevron: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1.5),
    color: theme.secondaryTextColor
  }
}))
