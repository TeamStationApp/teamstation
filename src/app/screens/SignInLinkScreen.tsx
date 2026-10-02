import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { GameStationClient, Session } from '../../common/api'
import { Button, Card, Screen } from '../components'
import { alreadyAsked, markAsked } from '../platform/onceStore'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface SignInLinkScreenProps {
  client: GameStationClient
  token: string
  /** Which sign-in the link belongs to, from `?r=`. */
  requestId?: string
  onSignedIn: (session: Session) => void
}

/**
 * Written when a sign-in is asked for here, so its own link is one tap.
 *
 * `onceStore` is the seam: a browser remembers this for as long as the tab is
 * open and an app for as long as it is running, which are the same rule said
 * in two vocabularies.
 */
export function rememberRequest(requestId: string): void {
  markAsked(requestId)
}

function askedHere(requestId: string | undefined): boolean {
  return requestId != null && alreadyAsked(requestId)
}

/**
 * The page the e-mail's button lands on.
 *
 * Opening it spends nothing. Mail scanners follow links before anybody reads
 * them and run no scripts, so a sign-in that happened on a bare page load would
 * be burnt — or worse, handed to whatever read the mailbox first. The token is
 * only spent when something behind it is known to be a person: this browser
 * asking for the sign-in in the first place, or a tap on the button below.
 */
export function SignInLinkScreen(
  props: SignInLinkScreenProps
): React.ReactElement {
  const { client, token, requestId, onSignedIn } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [busy, setBusy] = useState(askedHere(requestId))
  const [error, setError] = useState<string | undefined>(undefined)

  const signIn = (): void => {
    setBusy(true)
    setError(undefined)
    client
      .signInWithLink(token)
      .then(onSignedIn)
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : 'That link is no longer good'
        )
        setBusy(false)
      })
  }

  // One tap where the tap is known to have been a person's: this is the
  // browser that asked, so the link arriving here is the same person coming
  // back, and making them press a second button says nothing.
  useEffect(() => {
    if (!askedHere(requestId)) return
    signIn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Screen>
      <Card>
        <View style={styles.body}>
          <Text style={styles.title}>Sign in to GameStation</Text>
          {error != null && <Text style={styles.error}>{error}</Text>}
          {busy && error == null ? (
            <ActivityIndicator color={theme.primaryTextColor} />
          ) : (
            <Button label="Sign in" onPress={signIn} />
          )}
          <Text style={styles.note}>
            This link can be used once, and only for a few minutes after it was
            sent.
          </Text>
        </View>
      </Card>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  body: {
    gap: theme.rem(theme.spaceMdRem),
    alignItems: 'stretch'
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    textAlign: 'center'
  },
  note: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    textAlign: 'center'
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    textAlign: 'center'
  }
}))
