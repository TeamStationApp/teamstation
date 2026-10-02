import React from 'react'
import { View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface RadioMarkProps {
  /** Whether this is the chosen one. */
  on: boolean
}

/**
 * The ring beside a choice, drawn rather than typed.
 *
 * Both modals wrote `●` and `○` — U+25CF and U+25CB — as literal characters
 * in the app's own font, which has neither. That is the same mistake as the
 * `✉` on the account screen and the `◀` on the quarter-speed pill, and it
 * fails the same way: a browser quietly borrows the glyph from another font
 * and looks right, and iOS draws the missing-glyph box. These two are the
 * radio marks in the only two modals the app has, so both would have shown a
 * square where the selection should be.
 *
 * Two `View`s rather than a Material Symbol, which is what the account screen
 * used: a ring and a dot are a border-radius and a background, they need no
 * font at all, and the filled state is then exactly concentric with the empty
 * one — which a glyph pair is not, because `●` and `○` are drawn at different
 * optical sizes in most faces.
 */
export function RadioMark(props: RadioMarkProps): React.ReactElement {
  const { on } = props
  const styles = getStyles(useTheme())
  return (
    <View style={[styles.ring, on && styles.ringOn]}>
      {on && <View style={styles.dot} />}
    </View>
  )
}

const SIZE_REM = 1
/** Half the ring, so the dot reads as filling it rather than sitting in it. */
const DOT_REM = 0.5

const getStyles = cacheStyles((theme: Theme) => ({
  ring: {
    width: theme.rem(SIZE_REM),
    height: theme.rem(SIZE_REM),
    borderRadius: theme.rem(SIZE_REM / 2),
    borderWidth: 1.5,
    borderColor: theme.secondaryTextColor,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ringOn: {
    borderColor: theme.activeColor
  },
  dot: {
    width: theme.rem(DOT_REM),
    height: theme.rem(DOT_REM),
    borderRadius: theme.rem(DOT_REM / 2),
    backgroundColor: theme.activeColor
  }
}))
