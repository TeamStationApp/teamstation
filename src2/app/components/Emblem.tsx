import React, { useState } from 'react'
import { Image, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface EmblemProps {
  /** Signed, short-lived, and often absent. */
  uri?: string | null
  /** Drawn when there is no picture, or when the picture will not load. */
  fallback: string
  /** A badge is square with soft corners; a face is a circle. */
  shape?: 'rounded' | 'circle'
  /** In rem, like every other size. */
  size?: number
}

/**
 * The picture at the front of a row, or the letters that stand in for it.
 *
 * Falling back on a **load error** as well as on a missing URL is the part
 * that matters: these links are signed and expire, so a tab left open
 * overnight will ask for a picture with a stale signature and be refused. The
 * letters are a better answer than a broken-image glyph, and the row keeps its
 * shape either way.
 */
export function Emblem(props: EmblemProps): React.ReactElement {
  const { uri, fallback, shape = 'rounded', size = 2.5 } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [failed, setFailed] = useState(false)

  const box = {
    width: theme.rem(size),
    height: theme.rem(size),
    borderRadius:
      shape === 'circle' ? theme.radiusPill : theme.rem(theme.radiusRem)
  }

  if (uri == null || uri === '' || failed) {
    return (
      <View style={[styles.tile, box]}>
        <Text style={styles.letters} numberOfLines={1}>
          {fallback}
        </Text>
      </View>
    )
  }

  return (
    <Image
      accessibilityIgnoresInvertColors
      source={{ uri }}
      style={[styles.picture, box]}
      onError={() => {
        setFailed(true)
      }}
    />
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  tile: {
    backgroundColor: theme.containerBackgroundColor,
    alignItems: 'center',
    justifyContent: 'center'
  },
  letters: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '700',
    color: theme.activeColor
  },
  picture: {
    // The same plate the letters sit on, so a picture that is still loading
    // and a row that has none are the same shape rather than a hole.
    backgroundColor: theme.containerBackgroundColor
  }
}))
