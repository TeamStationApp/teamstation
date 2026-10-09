import React from 'react'
import { Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

/**
 * What the app shows when a screen fails while drawing, in place of a blank
 * window: the failure has already been reported, and Reload draws the app
 * again from the top.
 */
export function ErrorFallback({
  onReload
}: {
  onReload: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.screen} accessibilityRole="alert">
      <Text accessibilityRole="header" style={styles.title}>
        {lstrings.error_fallback_title}
      </Text>
      <Text style={styles.body}>{lstrings.error_fallback_body}</Text>
      <Button label={lstrings.error_fallback_reload} onPress={onReload} />
    </View>
  )
}

/** The fallback an error boundary renders: this screen, reloading the boundary. */
export function errorScreen(boundary: {
  resetError: () => void
}): React.ReactElement {
  return (
    <ErrorFallback
      onReload={() => {
        boundary.resetError()
      }}
    />
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(2),
    gap: theme.rem(1),
    backgroundColor: theme.backgroundColor
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    textAlign: 'center'
  },
  body: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    textAlign: 'center',
    maxWidth: theme.rem(24)
  }
}))
