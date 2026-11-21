import React from 'react'
import { Platform, View } from 'react-native'

import { SEARCH_FIELD_HEIGHT } from '../components/SearchField'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { KeyboardSpacer, SearchDock } from './SearchDock'

/** Between the field and what is under it: the tab bar, or the keyboard. */
export const SEARCH_FIELD_GAP = 12

/**
 * Where a search field sits: at the top in a browser, which has no keyboard
 * to rise over and a pointer that is not a thumb; else in a
 * `SearchFieldDock` at the bottom.
 */
export function searchFieldOnTop(): boolean {
  return Platform.OS === 'web'
}

/**
 * A search field floating at the bottom of a phone's or tablet's screen,
 * with what it suggests (Search's location pills) right above it, both
 * riding the keyboard up and back down (`SearchDock`). Search and Add
 * Player both put their field in it. Its parent is the screen's full area,
 * the dock absolutely placed over the foot of what scrolls.
 */
export function SearchFieldDock({
  bottom,
  active,
  side,
  field,
  pills,
  onHeight
}: {
  /** Above the area's foot, with the keyboard closed. */
  bottom: number
  /**
   * The screen is on show: on Android, the keyboard controller is held.
   * Not enough in a `Modal`: there the controller must already be on when
   * the modal shows, or it never attaches to the modal's window and the dock
   * cannot ride the keyboard. Hold it with `useKeyboardControllerHeld()` and
   * render the modal only once that is true, as Add Player does.
   */
  active: boolean
  /** The column's side margins, so the field lines up with the rows. */
  side: { left: number; right: number }
  field: React.ReactElement
  pills?: React.ReactNode
  /** The dock's height, pills and all, for `SearchFieldClearance`. */
  onHeight: (height: number) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const hasPills = pills != null && pills !== false
  return (
    <SearchDock
      bottom={bottom}
      gap={SEARCH_FIELD_GAP}
      active={active}
      style={styles.dock}
      onLayout={event => {
        onHeight(event.nativeEvent.layout.height)
      }}
    >
      <View
        style={[
          styles.dockColumn,
          { paddingLeft: side.left, paddingRight: side.right }
        ]}
      >
        {/* One tree whether pills show or not: moving the field would
            remount its input, and drop its focus and keyboard. */}
        <View style={hasPills && styles.dockGround}>
          {hasPills && <View style={styles.dockPills}>{pills}</View>}
          {field}
        </View>
      </View>
    </SearchDock>
  )
}

/**
 * The room under the last row: the floating dock's height and its gap, and
 * on Android the keyboard's, so the last row scrolls clear of the raised
 * dock.
 */
export function SearchFieldClearance({
  dockHeight,
  under = 0
}: {
  dockHeight: number
  /** What the dock rests above that the list runs over: a home indicator. */
  under?: number
}): React.ReactElement {
  return (
    <>
      <View
        testID="search-field-clearance"
        style={{ height: dockHeight + SEARCH_FIELD_GAP + under }}
      />
      <KeyboardSpacer />
    </>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  dock: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    alignItems: 'center' as const
  },
  dockColumn: {
    width: '100%' as const,
    maxWidth: theme.rem(theme.maxContentWidthRem)
  },
  // The pills ride directly above the field, and both sit on the page's own
  // ground, rounded under the field as it is, so the results scrolling
  // beneath never show between them.
  dockGround: {
    backgroundColor: theme.backgroundColor,
    borderBottomLeftRadius: SEARCH_FIELD_HEIGHT / 2,
    borderBottomRightRadius: SEARCH_FIELD_HEIGHT / 2
  },
  dockPills: {
    paddingBottom: theme.rem(0.25)
  }
}))
