import React, { useEffect, useState } from 'react'
import { Linking, StatusBar, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { App } from '../App'
import { seedRoute } from '../navigation/useAddressBar'
import { loadToken, saveToken } from '../platform/sessionStore'
import { getTheme } from '../theme/ThemeContext'
import { apiBaseUrl } from './config'

/**
 * The native entry point, and the twin of `app/web/index.tsx`.
 *
 * Everything below `App` is the same code the browser runs. What is here is
 * only what a phone needs and a page does not: the insets the hardware cuts
 * out of the window, the gesture root the player's nine squares are built on,
 * and the two answers below that a browser gives for free.
 *
 * **The address it was opened on.** `App` reads `currentRoute()` inside four
 * `useState` initialisers, which run once and cannot wait for anything, while
 * `Linking.getInitialURL()` is a promise. So the promise is settled *before*
 * `App` is mounted at all. Mounting first and re-routing after would not do:
 * the four initialisers would already have decided the app was on the home
 * screen, which is how a sign-in link from the e-mail — the way most people
 * get in — becomes a sign-in link to nowhere.
 *
 * **The session.** A browser keeps an `HttpOnly` cookie the app cannot read
 * and sends it by itself; a phone has no cookie jar, which the server already
 * knows — `server/auth/tokens.ts` reads an `Authorization` header first and
 * says so. The token from the last launch is read here and handed to the
 * client before it asks anybody who it is.
 *
 * Neither answer is available synchronously, so nothing is drawn until both
 * are. That is one frame of the launch screen, which is already on screen and
 * already the right colour — a visibly empty app that then jumps is worse.
 */
export function Root(): React.ReactElement {
  const theme = getTheme()
  const [opened, setOpened] = useState<{ token?: string } | undefined>(
    undefined
  )

  useEffect(() => {
    let live = true
    const settle = async (): Promise<void> => {
      // Both at once: neither waits on the other, and a slow storage read
      // should not hold up an address that is already in hand.
      const [url, token] = await Promise.all([
        Linking.getInitialURL().catch(() => null),
        loadToken()
      ])
      if (!live) return
      seedRoute(url)
      setOpened({ token })
    }
    settle().catch(() => {
      if (live) setOpened({})
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/*
          Only the one property. Android is drawn edge to edge by default from
          React Native 0.87, so a bar colour and a `translucent` flag are both
          gone — the window already runs under the status bar and the insets
          are what keep the header out from under it.
        */}
        <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
        {opened == null ? (
          // The launch screen's own colour, so the wait is invisible.
          <View style={{ flex: 1, backgroundColor: theme.backgroundColor }} />
        ) : (
          <App
            apiBaseUrl={apiBaseUrl}
            initialToken={opened.token}
            onToken={token => {
              saveToken(token).catch(() => undefined)
            }}
          />
        )}
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
