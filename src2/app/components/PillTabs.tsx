import React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useBreakpoint } from './useBreakpoint'

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
  /**
   * `compact` paints a smaller pill. It does **not** shrink the target: the
   * pressable keeps its height and the pill is drawn inside it.
   */
  size?: 'regular' | 'compact'
  /**
   * Share the row out evenly **when the row is a phone's width**. Wider than
   * that it is ignored and the pills size to their text: four tabs sharing a
   * 1100px column are 270px slabs, which is not the control Paul approved on
   * a phone — it is a different one that happens to have the same words on
   * it. The filter strips never stretch, so this also stops the same
   * `Past / Upcoming / All` row being drawn two ways on two screens.
   */
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
  const { tabs, selected, onSelect, size = 'regular' } = props
  const compact = size === 'compact'
  const narrow = useBreakpoint() === 'phone'
  const stretch = props.stretch === true && narrow
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
              styles.target,
              stretch && styles.pillStretch,
              pressed && !isSelected && styles.targetPressed
            ]}
          >
            <View
              style={[
                styles.pill,
                compact && styles.pillCompact,
                stretch && styles.pillFill,
                isSelected ? styles.pillActive : styles.pillIdle
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  compact && styles.labelCompact,
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
            </View>
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
  // What the finger gets: 48 tall, which the spec asks for so a tab can be hit
  // one-handed while somebody is also holding a scorebook. It is transparent —
  // shrinking the pill is a drawing decision and must not shrink this.
  target: {
    minHeight: theme.rem(3),
    justifyContent: 'center'
  },
  targetPressed: {
    opacity: 0.85
  },
  // What the eye gets.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceLgRem),
    borderRadius: theme.radiusPill
  },
  pillCompact: {
    minHeight: theme.rem(2.25),
    paddingHorizontal: theme.rem(theme.spaceMdRem)
  },
  pillStretch: {
    flex: 1
  },
  pillFill: {
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
  labelCompact: {
    fontSize: theme.rem(0.875)
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
