import React, { useMemo } from 'react'
import { Text } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { Handoff } from './handoff'
import { HandoffView } from './HandoffView'
import { useHeaderHandoff, useHeaderSlot } from './headerSlot'
import { useHandoff } from './useHandoff'

/**
 * A page title that moves into the header as the page scrolls up — the
 * design standard for every page that names itself, so the header never
 * repeats a title that is still on screen.
 *
 * Put `ref` on the on-page title and `handleScroll` on the screen's scroller.
 */
export function useTitleHandoff(
  title: string
): Pick<Handoff, 'ref' | 'handleScroll'> {
  const styles = getStyles(useTheme())
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const { progress } = handoff
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
        </HandoffView>
      ),
      [progress, styles.headerTitle, title]
    )
  )
  return { ref: handoff.ref, handleScroll: handoff.handleScroll }
}

const getStyles = cacheStyles((theme: Theme) => ({
  headerTitle: {
    color: theme.headerTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '700'
  }
}))
