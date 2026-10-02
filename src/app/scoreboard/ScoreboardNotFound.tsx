import React from 'react'
import { Image, Text, View } from 'react-native'

import { tsLogoSource } from '../assets'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * What a closed scoreboard shows: the scoreboard page of a game whose board
 * has closed, has been cancelled or never existed, and the override
 * dashboard of such a game or of one the visitor does not run.
 *
 * A branded page rather than a bare 404, because whoever opens a stale
 * scoreboard link is somebody who watches youth baseball, which is exactly
 * who TeamStation is for. It fills the window on an opaque brand background,
 * so it reads as a page even where the scoreboard page is otherwise
 * transparent.
 */
export function ScoreboardNotFound(): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <View style={styles.page} accessibilityRole="summary">
      <Image
        accessibilityIgnoresInvertColors
        accessibilityLabel="TeamStation"
        resizeMode="contain"
        source={tsLogoSource}
        style={styles.logo}
      />
      <Text accessibilityRole="header" style={styles.title}>
        {lstrings.scoreboard_not_live}
      </Text>
      <Text style={styles.detail}>{lstrings.scoreboard_not_live_detail}</Text>
      {/*
        A link rather than a button: react-native-web draws a Text with an
        `href` as an `<a>`, so it opens in a new tab, can be copied, and needs
        no app behind it. React Native's own types do not list the prop.
      */}
      <Text accessibilityRole="link" {...signUpLink} style={styles.signUp}>
        {lstrings.scoreboard_sign_up}
      </Text>
    </View>
  )
}

const signUpLink: object = { href: '/sign-in' }

const getStyles = cacheStyles((theme: Theme) => ({
  page: {
    flex: 1,
    alignSelf: 'stretch',
    minHeight: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(2),
    gap: theme.rem(1),
    backgroundColor: theme.scoreboardBackground
  },
  logo: {
    width: theme.rem(5),
    height: theme.rem(5)
  },
  title: {
    color: theme.scoreboardTextColor,
    fontFamily: theme.boldTextFont,
    fontWeight: '700',
    fontSize: theme.rem(1.75),
    textAlign: 'center'
  },
  detail: {
    color: theme.scoreboardMutedTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    textAlign: 'center',
    maxWidth: theme.rem(26)
  },
  signUp: {
    marginTop: theme.rem(1),
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1.5),
    borderRadius: theme.rem(1.5),
    overflow: 'hidden',
    backgroundColor: theme.scoreboardAccentColor,
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontWeight: '700',
    fontSize: theme.rem(1),
    textDecorationLine: 'none'
  }
}))
