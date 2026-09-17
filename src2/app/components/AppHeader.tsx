import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface AppHeaderProps {
  title: string
  /** Set above the title in small caps, e.g. GAMESTATION. */
  overline?: string
  onBack?: () => void
  /** Up to two actions at the right. */
  actions?: Array<{ label: string; glyph: string; onPress: () => void }>
}

/**
 * The bar at the top of every screen: back, title, actions.
 *
 * It stays put while the content scrolls, which is what the designs show, and
 * it is the only place a screen's name is written — the title is not repeated
 * as a heading below, because on a phone that costs a third of the first
 * screenful to say the same word twice.
 */
export function AppHeader(props: AppHeaderProps): React.ReactElement {
  const { title, overline, onBack, actions = [] } = props
  const styles = getStyles(useTheme())

  return (
    <View style={styles.header}>
      {onBack != null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Text style={styles.backGlyph}>‹</Text>
          <Text style={styles.backLabel}>Back</Text>
        </Pressable>
      )}

      <View style={styles.titles}>
        {overline != null && (
          <Text style={styles.overline} numberOfLines={1}>
            {overline.toUpperCase()}
          </Text>
        )}
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>

      <View style={styles.actions}>
        {actions.map(action => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => {
              action.onPress()
            }}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionGlyph}>{action.glyph}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    minHeight: theme.rem(3.5),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem),
    backgroundColor: theme.headerBackgroundColor,
    borderBottomWidth: 1,
    borderBottomColor: theme.headerBorderColor
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.125),
    paddingRight: theme.rem(theme.spaceSmRem),
    minHeight: theme.rem(2.75)
  },
  backGlyph: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1.5),
    color: theme.headerTextColor
  },
  backLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.headerTextColor
  },
  titles: {
    flex: 1,
    alignItems: 'center'
  },
  overline: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.0625),
    color: theme.activeColor
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.headerTextColor
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  action: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radiusPill
  },
  actionGlyph: {
    fontSize: theme.rem(1.125),
    color: theme.headerTextColor
  },
  pressed: {
    opacity: 0.6
  }
}))
