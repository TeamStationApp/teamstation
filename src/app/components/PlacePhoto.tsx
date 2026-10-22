import React from 'react'
import { Image, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Icon } from './Icon'

/**
 * A venue's or field's photo in a hero card, 16:9 and full width, or a quiet
 * tile with the field mark when there is none yet.
 */
export function PlacePhoto({
  uri,
  label
}: {
  uri: string | null
  label: string
}): React.ReactElement {
  const styles = getStyles(useTheme())
  if (uri == null)
    return (
      <View
        testID="place-photo-empty"
        accessibilityLabel={`${label}: no photo yet`}
        style={[styles.frame, styles.empty]}
      >
        <Icon name="stadium" size={2.5} />
      </View>
    )
  return (
    <Image
      testID="place-photo"
      accessibilityLabel={label}
      source={{ uri }}
      resizeMode="cover"
      style={styles.frame}
    />
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  frame: {
    width: '100%' as const,
    aspectRatio: 16 / 9,
    borderRadius: theme.rem(0.75),
    overflow: 'hidden' as const
  },
  empty: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: theme.containerBackgroundColor
  }
}))
