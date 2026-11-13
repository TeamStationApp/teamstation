import React, { useEffect, useState } from 'react'
import { Alert, Linking, StatusBar, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { App } from '../App'
import { lstrings, sprintf } from '../locales/strings'
import { seedRoute } from '../navigation/useAddressBar'
import { deviceStorage } from '../platform/deviceStorage'
import {
  loadToken,
  loadUser,
  saveToken,
  saveUser
} from '../platform/sessionStore'
import type { StoredUser } from '../platform/storedUser'
import { openDocumentCache } from '../sync/cache'
import { getTheme } from '../theme/ThemeContext'
import { apiBaseUrl, appOrigin, setLaunchApiBaseUrl } from './config'
import { launchApi } from './launchApi'
import { saveServerOverride, serverLinkOf } from './serverOverride'

/**
 * A develop build's `teamstation-develop://server?origin=…` link keeps the
 * server for the next launch, and says so; it changes nothing now. Answers
 * whether `url` was such a link.
 */
function keepServerLink(url: string | null | undefined): boolean {
  const link = serverLinkOf(url)
  if (link == null) return false
  saveServerOverride(deviceStorage, appOrigin, link.origin).then(
    host => {
      Alert.alert(
        host == null
          ? lstrings.about_server_cleared
          : sprintf(lstrings.about_server_set, host)
      )
    },
    (error: unknown) => {
      Alert.alert(String(error instanceof Error ? error.message : error))
    }
  )
  return true
}

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
 * client before it asks anybody who it is, with who it last said that was:
 * with no signal at launch, that stored user is the session, and their
 * cached documents are what the app shows.
 *
 * Neither answer is available synchronously, so nothing is drawn until both
 * are. That is one frame of the launch screen, which is already on screen and
 * already the right colour — a visibly empty app that then jumps is worse.
 */
export function Root(): React.ReactElement {
  const theme = getTheme()
  const [opened, setOpened] = useState<
    { token?: string; user?: StoredUser; api: string } | undefined
  >(undefined)

  useEffect(() => {
    let live = true
    const settle = async (): Promise<void> => {
      // Both at once: neither waits on the other, and a slow storage read
      // should not hold up an address that is already in hand.
      const [url, token, user, api] = await Promise.all([
        Linking.getInitialURL().catch(() => null),
        loadToken(),
        loadUser(),
        launchApi()
      ])
      if (!live) return
      // A server link is kept for the next launch, not opened as a route.
      seedRoute(keepServerLink(url) ? null : (url ?? null))
      setLaunchApiBaseUrl(api)
      setOpened({ token, user, api })
    }
    settle().catch(() => {
      if (live) setOpened({ api: apiBaseUrl })
    })
    const links = Linking.addEventListener('url', ({ url }) => {
      keepServerLink(url)
    })
    return () => {
      live = false
      links.remove()
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
            apiBaseUrl={opened.api}
            initialToken={opened.token}
            initialUser={opened.user}
            onToken={token => {
              saveToken(token).catch(() => undefined)
            }}
            onUser={user => {
              saveUser(user).catch(() => undefined)
            }}
            documentCache={openDocumentCache}
          />
        )}
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
