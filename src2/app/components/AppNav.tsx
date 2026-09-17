import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useBreakpoint } from './useBreakpoint'

export type NavTabId = 'home' | 'videos' | 'schedule' | 'account'

export interface NavTab {
  id: NavTabId
  label: string
  glyph: string
}

/**
 * The four places the app goes.
 *
 * The designs disagreed: the home screen drew Teams / Videos / Schedule /
 * Seasons, the team hub drew Team Hub / Live Cams / League / Account. Picking
 * one meant deciding what the app is, so: Home carries both the teams and the
 * seasons, which is what Paul asked for on that screen, so a separate Seasons
 * tab would lead to the half of a screen the user just left. Live Cams is not
 * built. Account has to exist — signing out has to live somewhere.
 */
export const NAV_TABS: NavTab[] = [
  { id: 'home', label: 'Home', glyph: '⌂' },
  { id: 'videos', label: 'Videos', glyph: '▶' },
  { id: 'schedule', label: 'Schedule', glyph: '▦' },
  { id: 'account', label: 'Account', glyph: '☺' }
]

export interface AppNavProps {
  selected: NavTabId
  onSelect: (id: NavTabId) => void
}

/**
 * A bottom bar on a phone, a left rail on anything wider.
 *
 * A bar pinned to the bottom of a desktop window is a phone idiom stranded on
 * a monitor: it is a mile from the content, and it wastes the one axis a
 * desktop has spare. The rail keeps the same four destinations in the same
 * order, so there is nothing new to learn, and it can afford to show the label
 * beside the glyph rather than under it.
 */
export function AppNav(props: AppNavProps): React.ReactElement {
  const { selected, onSelect } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const isRail = useBreakpoint() !== 'phone'

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.container, isRail ? styles.rail : styles.bar]}
    >
      {NAV_TABS.map(tab => {
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
              styles.item,
              isRail ? styles.itemRail : styles.itemBar,
              isSelected && isRail && styles.itemRailSelected,
              pressed && styles.pressed
            ]}
          >
            <Text
              style={[
                styles.glyph,
                isSelected ? styles.selectedText : styles.idleText
              ]}
            >
              {tab.glyph}
            </Text>
            <Text
              style={[
                isRail ? styles.labelRail : styles.labelBar,
                isSelected ? styles.selectedText : styles.idleText
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  container: {
    backgroundColor: theme.navBackgroundColor,
    borderColor: theme.headerBorderColor
  },
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingBottom: theme.rem(theme.spaceXsRem)
  },
  rail: {
    flexDirection: 'column',
    borderRightWidth: 1,
    width: theme.rem(11),
    paddingTop: theme.rem(theme.spaceLgRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    gap: theme.rem(theme.spaceXsRem)
  },
  item: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  itemBar: {
    flex: 1,
    minHeight: theme.rem(3.25),
    gap: theme.rem(0.125)
  },
  itemRail: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: theme.rem(theme.spaceMdRem),
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem)
  },
  itemRailSelected: {
    backgroundColor: theme.containerBackgroundColor
  },
  pressed: {
    opacity: 0.6
  },
  glyph: {
    fontSize: theme.rem(1.125)
  },
  labelBar: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '600'
  },
  labelRail: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600'
  },
  idleText: {
    color: theme.navInactiveColor
  },
  selectedText: {
    color: theme.navActiveColor
  }
}))
