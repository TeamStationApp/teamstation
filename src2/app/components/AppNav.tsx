import React from 'react'
import { Pressable, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { glassStyle } from './glass'
import { Icon, type IconName } from './Icon'

export type NavTabId = 'home' | 'videos' | 'schedule'

export interface NavTab {
  id: NavTabId
  label: string
  icon: IconName
}

/**
 * The three places the app goes.
 *
 * The designs disagreed: the home screen drew Teams / Videos / Schedule /
 * Seasons, the team hub drew Team Hub / Live Cams / League / Account. Picking
 * one meant deciding what the app is, so: Home carries both the teams and the
 * seasons, which is what Paul asked for on that screen, so a separate Seasons
 * tab would lead to the half of a screen the user just left. Live Cams is not
 * built.
 *
 * Account is **not** here. It is reached by tapping your own picture at the
 * top right, which is where every application with a signed-in person puts it,
 * and which frees a quarter of the bar for the three things you actually move
 * between. Signing out still lives on that screen; it is simply not a
 * destination you navigate to as often as the ones that are left.
 */
export const NAV_TABS: NavTab[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'videos', label: 'Videos', icon: 'smart_display' },
  { id: 'schedule', label: 'Schedule', icon: 'event' }
]

export type NavMode = 'floating' | 'header'

export interface AppNavProps {
  selected: NavTabId
  onSelect: (id: NavTabId) => void
  /** A capsule floating over the content, or a row inside the header. */
  mode: NavMode
}

/**
 * Three icons, and no words.
 *
 * On a narrow screen they float over the content in a capsule rather than
 * partitioning it with a bar; on a wide one the same three sit in the header
 * beside the account picture, and there is no sidebar at all. A rail cost 176
 * pixels of every wide window to say three words that three glyphs say.
 *
 * The labels are gone from the paint and kept for the screen reader. Three
 * glyphs that never move are learned in a day; what a person actually needs
 * naming is the screen they are on, which the header says.
 */
export function AppNav(props: AppNavProps): React.ReactElement {
  const { selected, onSelect, mode } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const floating = mode === 'floating'

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.container,
        floating ? [styles.floating, glassStyle(theme)] : styles.inHeader
      ]}
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
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            {/*
              The target and the paint are different boxes. The target is 44pt
              wherever it is; the disc behind the selected icon is the size of
              the account picture beside it in the header, and the full target
              in the capsule, where there is nothing to match.
            */}
            <View
              style={[
                floating ? styles.discFloating : styles.discInHeader,
                isSelected && styles.discSelected
              ]}
            >
              <Icon
                name={tab.icon}
                color={
                  isSelected ? theme.navActiveColor : theme.navInactiveColor
                }
              />
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  floating: {
    // Over the content, not beside it: a bar across the bottom of a phone is a
    // strip of chrome under the thing somebody came to look at.
    position: 'absolute',
    bottom: theme.rem(1),
    alignSelf: 'center',
    // Half again on the gap: with no labels between them the three glyphs read
    // as one shape at the spacing the rest of the app uses.
    gap: theme.rem(theme.spaceXsRem * 1.5),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.1875),
    borderRadius: theme.rem(2),
    borderWidth: 1,
    borderColor: theme.glassBorderColor,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    zIndex: 5
  },
  inHeader: {
    gap: theme.rem(theme.spaceXsRem)
  },
  item: {
    // The paint shrank when the labels went; the target did not. A thumb at a
    // ball field, often one-handed, is the thing being designed for.
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  discFloating: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    borderRadius: theme.rem(1.375),
    alignItems: 'center',
    justifyContent: 'center'
  },
  discInHeader: {
    // The account picture's size, so the row reads as one line of circles
    // rather than three large ones and a small one.
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    alignItems: 'center',
    justifyContent: 'center'
  },
  discSelected: {
    // With no label to bolden, the selected tab needs to differ by more than a
    // shade of grey.
    backgroundColor: theme.containerBackgroundColor
  },
  pressed: {
    opacity: 0.6
  }
}))
