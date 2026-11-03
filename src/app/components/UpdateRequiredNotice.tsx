import React from 'react'
import { Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Card } from './Card'

/**
 * What the app shows over every screen once the server has refused to send
 * it a game because this build is older than the game socket's protocol:
 * nothing it would be sent can be read, so it says to update. On the web a
 * reload fetches the new build, so `onReload` is given there; a phone has to
 * be updated from its store, and shows no button.
 */
export function UpdateRequiredNotice({
  onReload
}: {
  onReload?: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.scrim} accessibilityViewIsModal>
      <Card style={styles.card} testID="updateRequiredNotice">
        <View accessibilityRole="alert" style={styles.text}>
          <Text accessibilityRole="header" style={styles.title}>
            {lstrings.update_required_title}
          </Text>
          <Text style={styles.body}>{lstrings.update_required_body}</Text>
        </View>
        {onReload != null && (
          <Button
            label={lstrings.update_required_reload}
            onPress={onReload}
            block
          />
        )}
      </Card>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(1),
    backgroundColor: theme.overlayBackgroundColor
  },
  card: {
    width: '100%',
    maxWidth: theme.rem(24),
    padding: theme.rem(1.5),
    gap: theme.rem(1.25)
  },
  text: { gap: theme.rem(0.5) },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    textAlign: 'center'
  },
  body: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    textAlign: 'center'
  }
}))
