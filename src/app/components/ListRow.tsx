import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Badge, type BadgeTone } from './Badge'
import { Emblem } from './Emblem'
import { Icon, type IconName } from './Icon'

export interface ListRowProps {
  title: string
  subtitle?: string
  /** A short glyph or initials in the leading tile. */
  emblem?: string
  /** A Material Symbol in the leading tile, in place of the initials. */
  emblemIcon?: IconName
  /** A picture for the leading tile. The glyph is what shows without one. */
  emblemUri?: string | null
  /** A face is a circle; everything else is a soft square. */
  emblemShape?: 'rounded' | 'circle'
  badgeLabel?: string
  badgeTone?: BadgeTone
  /**
   * A short figure at the right, right-justified in a column of its own:
   * a jersey number, `#12`.
   *
   * Not a `Badge`, and not for a status. The tinted pill means `2nd Place` or
   * `W 4–0` elsewhere in the app, and a number is not one of those. The fixed
   * width is what keeps `#7` and `#12` on the same right edge down a list, and
   * what keeps them there when a chevron follows.
   */
  trailing?: string
  /** Sits where a badge would, ahead of the chevron. */
  end?: React.ReactNode
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
  const {
    title,
    subtitle,
    emblem,
    emblemIcon,
    emblemUri,
    emblemShape,
    badgeLabel,
    badgeTone,
    trailing,
    end,
    onPress
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const content = (
    <>
      {(emblem != null || emblemIcon != null) && (
        <Emblem
          uri={emblemUri}
          fallback={emblem ?? ''}
          icon={emblemIcon}
          shape={emblemShape}
        />
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
      {trailing != null && (
        <Text style={styles.trailing} numberOfLines={1}>
          {trailing}
        </Text>
      )}
      {badgeLabel != null && <Badge label={badgeLabel} tone={badgeTone} />}
      {end}
      {onPress != null && (
        <Icon name="chevron_right" color={theme.secondaryTextColor} />
      )}
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
  trailing: {
    width: theme.rem(2.75),
    textAlign: 'right',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.secondaryTextColor
  }
}))
