import React from 'react'
import { ScrollView, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface WideTableProps {
  children: React.ReactNode
}

/**
 * A table that is wider than the screen, and says so by moving.
 *
 * A batting line is ten columns and a phone is not ten columns wide. The
 * alternative to scrolling is what was happening before: the last column —
 * the batting average, which is the one people look for — was quietly cut off
 * at the edge of the card with no way to reach it.
 *
 * The name column is pinned while the figures slide under it, so a row
 * scrolled to its last column is still somebody's. That is `position: sticky`
 * on the name cell — a position React Native has no name for, which is what
 * `webStyle` is for — rather than a second column beside the scroll, because
 * splitting every row in two would cost the row its single press target.
 */
export function WideTable(props: WideTableProps): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      // The rows size themselves; the scroll view must not stretch them to its
      // own width, or there would be nothing to scroll.
      contentContainerStyle={styles.content}
    >
      {/*
        Grows into a window wider than the table and stays at its own width in
        one narrower, which is what makes it scroll: flex only gives out space
        that exists.
      */}
      <View style={styles.body}>{props.children}</View>
    </ScrollView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  content: {
    flexGrow: 1,
    paddingRight: theme.rem(theme.spaceSmRem)
  },
  body: {
    flexGrow: 1
  }
}))
