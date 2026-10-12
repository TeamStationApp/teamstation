import React from 'react'
import {
  type StyleProp,
  View,
  type ViewProps,
  type ViewStyle
} from 'react-native'

import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface CardProps {
  children: React.ReactNode
  /** No inner padding, for a card whose child paints to the edge. */
  flush?: boolean
  /** A left edge in the accent colour, marking a row worth noticing. */
  accent?: boolean
  style?: StyleProp<ViewStyle>
  /**
   * So a screen can watch where this card is as the page scrolls.
   *
   * A `React.Ref` rather than a callback, because `useHandoff` hands back an
   * animated ref on a phone — it measures the same rectangle on the animation
   * thread, where a browser can simply be asked for it.
   */
  ref?: React.Ref<React.ComponentRef<typeof View>>
}

/**
 * White on the warm canvas, a hairline border, and a shadow so faint it reads
 * as paper rather than as a pop-up. The border is what does the work: against
 * a bone background a pure shadow is nearly invisible in sunlight, which is
 * where half of these screens are read.
 */
export function Card(props: CardProps): React.ReactElement {
  const { children, flush = false, accent = false, style, ref } = props
  const styles = getStyles(useTheme())
  return (
    <View
      ref={ref}
      // A card somebody is watching the position of must survive Android's
      // view flattening, which folds away any view that only groups its
      // children — and a folded view has no position to measure.
      collapsable={ref == null ? undefined : false}
      style={[
        styles.card,
        !flush && styles.padded,
        accent && styles.accent,
        style
      ]}
    >
      {children}
    </View>
  )
}

/** One padded section of a flush card. Its parent must not add another inset. */
export function CardContent({
  style,
  ...props
}: ViewProps): React.ReactElement {
  const styles = getStyles(useTheme())
  return <View {...props} style={[styles.padded, style]} />
}

/** A list divider has no vertical margin; each adjacent row owns its inset. */
export function CardDivider(): React.ReactElement {
  const styles = getStyles(useTheme())
  return <View style={styles.divider} />
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    overflow: 'hidden',
    shadowColor: theme.shadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(0.375),
    shadowOffset: { width: 0, height: theme.rem(0.125) },
    elevation: elevationFor(theme.rem(0.375))
  },
  padded: {
    padding: theme.rem(theme.cardContentInsetRem)
  },
  divider: {
    height: 1,
    marginHorizontal: theme.rem(theme.cardContentInsetRem),
    backgroundColor: theme.defaultBorderColor
  },
  accent: {
    borderLeftWidth: theme.rem(0.25),
    borderLeftColor: theme.warningColor
  }
}))
