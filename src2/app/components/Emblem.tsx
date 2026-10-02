import React, { useState } from 'react'
import { Image, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Icon, type IconName } from './Icon'

export interface EmblemProps {
  /** Signed, short-lived, and often absent. */
  uri?: string | null
  /** Drawn when there is no picture, or when the picture will not load. */
  fallback: string
  /**
   * A Material Symbol instead of the letters, for a row that stands for a
   * thing rather than a person — an address, a role.
   *
   * It exists because the alternative was a literal pictograph in the source
   * (`✉`, `☺`), and those are not in Space Grotesk. A browser quietly borrows
   * one from Noto and draws an envelope; iOS has nothing to borrow and draws
   * the missing-glyph box. Material Symbols ships with the app, so this is the
   * same picture everywhere, which the pictograph never was.
   */
  icon?: IconName
  /** A badge is square with soft corners; a face is a circle. */
  shape?: 'rounded' | 'circle'
  /** In rem, like every other size. */
  size?: number
  /**
   * The tile's own colour, with white letters on it, for a team: each team
   * keeps one colour of its own (`teamTint`). Without it the tile is the
   * theme's pale container with letters in the active colour.
   */
  tint?: string
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
  const { uri, fallback, icon, shape = 'rounded', size = 2.5, tint } = props
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
      <View
        style={[styles.tile, box, tint != null && { backgroundColor: tint }]}
      >
        {icon != null ? (
          <Icon name={icon} size={size / 2} color={theme.activeColor} />
        ) : (
          <Text
            style={[
              styles.letters,
              // Two letters sized to the tile, so a smaller team mark keeps
              // the same margin round them as the larger default.
              tint != null && {
                ...styles.lettersOnTint,
                fontSize: theme.rem(size * 0.4)
              }
            ]}
            numberOfLines={1}
          >
            {fallback}
          </Text>
        )}
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
  lettersOnTint: {
    color: '#FFFFFF'
  },
  picture: {
    // The same plate the letters sit on, so a picture that is still loading
    // and a row that has none are the same shape rather than a hole.
    backgroundColor: theme.containerBackgroundColor
  }
}))
