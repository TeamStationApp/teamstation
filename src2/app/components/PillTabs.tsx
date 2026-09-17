import React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PillTab<Id extends string = string> {
  id: Id
  label: string
  /** Shown after the label, e.g. a count of videos. */
  badge?: string
}

export interface PillTabsProps<Id extends string = string> {
  tabs: Array<PillTab<Id>>
  selected: Id
  onSelect: (id: Id) => void
  /** Fills the width and shares it evenly. Off, the pills size to their text. */
  stretch?: boolean
  accessibilityLabel?: string
}

/**
 * The pill tab strip.
 *
 * The designs used this shape in four places and drew it four ways — a filled
 * dark pill on the team hub, an underline on the league hub, a bordered chip
 * for schedule filters, a segmented control on the game screen. Paul asked for
 * one of them, used everywhere, so this is it: the team hub's, because that is
 * the screen the palette came from.
 *
 * It scrolls sideways rather than wrapping or shrinking. Four tabs fit a phone;
 * a fifth would either wrap to a second line that looks like a mistake, or
 * squeeze the labels until they truncate. Scrolling keeps every tab the same
 * size and full-width targets on a desktop, where `stretch` shares the row out
 * instead.
 */
export function PillTabs<Id extends string = string>(
  props: PillTabsProps<Id>
): React.ReactElement {
  const { tabs, selected, onSelect, stretch = false } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const row = (
    <View style={[styles.row, stretch && styles.rowStretch]}>
      {tabs.map(tab => {
        const isSelected = tab.id === selected
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={tab.label}
            onPress={() => {
              onSelect(tab.id)
            }}
            style={({ pressed }) => [
              styles.pill,
              stretch && styles.pillStretch,
              isSelected ? styles.pillActive : styles.pillIdle,
              pressed && !isSelected && styles.pillPressed
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.label,
                isSelected ? styles.labelActive : styles.labelIdle
              ]}
            >
              {tab.label}
            </Text>
            {tab.badge != null && (
              <Text
                style={[
                  styles.badge,
                  isSelected ? styles.labelActive : styles.badgeIdle
                ]}
              >
                {tab.badge}
              </Text>
            )}
          </Pressable>
        )
      })}
    </View>
  )

  // Stretched, the row already fits by construction, and a ScrollView would
  // stop it filling the width.
  if (stretch) return row

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={props.accessibilityLabel}
      contentContainerStyle={styles.scrollContent}
    >
      {row}
    </ScrollView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrollContent: {
    paddingHorizontal: theme.rem(theme.spaceXsRem)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  rowStretch: {
    width: '100%'
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceXsRem),
    // 48 tall, which the spec asks for so a tab can be hit one-handed while
    // somebody is also holding a scorebook.
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceLgRem),
    borderRadius: theme.radiusPill
  },
  pillStretch: {
    flex: 1,
    paddingHorizontal: theme.rem(theme.spaceSmRem)
  },
  pillIdle: {
    backgroundColor: theme.pillBackground
  },
  pillPressed: {
    backgroundColor: theme.pillPressedBackground
  },
  pillActive: {
    backgroundColor: theme.pillActiveBackground
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600'
  },
  labelIdle: {
    color: theme.pillTextColor
  },
  labelActive: {
    color: theme.pillActiveTextColor
  },
  badge: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700'
  },
  badgeIdle: {
    color: theme.secondaryTextColor
  }
}))
