import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { PIN_MAP_FAILED, pinPointText } from './pinMapDocument'

/**
 * What a pin map shows in its place when Google's map cannot draw: the same
 * words and coordinates as the web document's panel, and Retry.
 */
export function PinMapUnavailable({
  latitude,
  longitude,
  onRetry
}: {
  latitude: number
  longitude: number
  onRetry: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View
      testID="pin-map-unavailable"
      accessibilityRole="alert"
      style={styles.panel}
    >
      <Text style={styles.title}>{PIN_MAP_FAILED}</Text>
      <Text style={styles.where}>{pinPointText({ latitude, longitude })}</Text>
      <Button label="Retry" compact onPress={onRetry} testID="pin-map-retry" />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  panel: {
    height: 260,
    width: '100%' as const,
    borderRadius: 16,
    padding: theme.rem(1),
    gap: theme.rem(0.5),
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: theme.containerBackgroundColor
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.0625),
    textAlign: 'center' as const
  },
  where: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  }
}))
