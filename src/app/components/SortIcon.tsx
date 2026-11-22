import React from 'react'
import { Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** A sort's glyph pair, A/Z for names and 1/9 for numbers, or no sort. */
export type SortGlyph = 'AZ' | 'ZA' | '19' | '91' | 'none'

/** The up caret's and the down caret's strokes, in a 6 by 4 box. */
const UP = 'M1 3.5 L3 1 L5 3.5'
const DOWN = 'M1 0.5 L3 3 L5 0.5'
/** ⇅: an arrow up and an arrow down side by side, in a 16-unit box. */
const ARROWS = 'M5 13 V3 M2 6 L5 3 L8 6 M11 3 V13 M8 10 L11 13 L14 10'

/**
 * A sort's direction, as the issue drew it: the two characters side by side
 * in the label's semibold face, with a small caret above and below between
 * them, so the order of the characters reads which way the sort runs. With no
 * sort, ⇅ as two arrows. One rem tall, in the colour of the label beside it.
 */
export function SortIcon({
  glyph,
  color
}: {
  glyph: SortGlyph
  color: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const box = theme.rem(1)
  if (glyph === 'none')
    return (
      <View
        testID="sort-icon"
        accessible={false}
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.box, { width: box }]}
      >
        <Svg width={box} height={box} viewBox="0 0 16 16">
          <Path
            testID="sort-icon-arrows"
            d={ARROWS}
            stroke={color}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      </View>
    )
  const caretWidth = theme.rem(0.375)
  const caretHeight = theme.rem(0.25)
  const caret = (d: string, id: string): React.ReactElement => (
    <Svg width={caretWidth} height={caretHeight} viewBox="0 0 6 4" testID={id}>
      <Path
        d={d}
        stroke={color}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  )
  return (
    <View
      testID="sort-icon"
      accessible={false}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={styles.box}
    >
      <Text selectable={false} style={[styles.glyph, { color }]}>
        {glyph[0]}
      </Text>
      <View style={styles.carets}>
        {caret(UP, 'sort-icon-up')}
        {caret(DOWN, 'sort-icon-down')}
      </View>
      <Text selectable={false} style={[styles.glyph, { color }]}>
        {glyph[1]}
      </Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  box: {
    height: theme.rem(1),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  glyph: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(0.6875),
    lineHeight: theme.rem(1),
    includeFontPadding: false
  },
  // The carets stand between the characters, one above the middle line and
  // one below it.
  carets: {
    height: theme.rem(1),
    justifyContent: 'space-between',
    paddingVertical: theme.rem(0.0625)
  }
}))
