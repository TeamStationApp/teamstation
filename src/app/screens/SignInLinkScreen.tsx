import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { Session, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { Button, Card, Screen } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface SignInLinkScreenProps {
  client: TeamStationClient
  token: string
  onSignedIn: (session: Session) => void
  /**
   * The ordinary sign-in form. `linkSpent` when the server refused the link,
   * so the form can take the dead link's place in the history; otherwise the
   * link may still work, and Back should find it.
   */
  onSignInAgain: (linkSpent: boolean) => void
}

type Failure =
  | { kind: 'refused' }
  /** `retry` is false where asking again at once cannot help: a rate limit. */
  | { kind: 'failed'; message: string; retry: boolean }

/**
 * Where each link's sign-in has got to, kept apart from its screen.
 *
 * The link is one-use on the server, so it is asked for once at a time
 * however often its screen is drawn — an effect run twice, a redraw, a
 * remount. The session goes, once, to the screen for the link that is showing
 * when it arrives, and to nobody if none is: a person who has moved on — to
 * the form, to another account, or signed out — is not signed in behind their
 * back. A refusal is kept, so a redraw says so without asking again; nothing
 * else is, and no session ever is.
 */
const attempts = new Map<string, Promise<Failure | undefined>>()
const deliverTo = new Map<string, (session: Session) => void>()

async function spend(
  client: TeamStationClient,
  token: string
): Promise<Failure | undefined> {
  const known = attempts.get(token)
  if (known != null) return await known
  const attempt = client.signInWithLink(token).then(
    (session): Failure | undefined => {
      attempts.delete(token)
      try {
        deliverTo.get(token)?.(session)
        return undefined
      } catch (error: unknown) {
        return {
          kind: 'failed',
          message:
            error instanceof Error ? error.message : 'Something went wrong',
          retry: false
        }
      }
    },
    (error: unknown): Failure => {
      if (error instanceof HttpError && error.code === 'unauthorized') {
        return { kind: 'refused' }
      }
      attempts.delete(token)
      return {
        kind: 'failed',
        message:
          error instanceof Error ? error.message : 'Something went wrong',
        retry: !(error instanceof HttpError && error.code === 'rateLimited')
      }
    }
  )
  attempts.set(token, attempt)
  return await attempt
}

/**
 * The page the e-mail's button lands on.
 *
 * It signs the person straight in, the same as typing the code does. The
 * token is spent by a `POST` this page makes once it is running, never by the
 * page load: mail scanners that follow links without running scripts would
 * otherwise burn a sign-in before it is read.
 *
 * A link the server refuses cannot be tried again, so its button goes to the
 * form, where a new one can be asked for. Anything else — no network, too
 * many tries, the server falling over — may have left the link unspent, so
 * the page offers to try it again where that can help. The form is one tap
 * away throughout, the wait included: a request that hangs on a field's
 * captive portal never answers at all.
 *
 * Drawn once per link — the shell keys it by token — so an answer for one
 * link never lands on the screen of another.
 */
export function SignInLinkScreen(
  props: SignInLinkScreenProps
): React.ReactElement {
  const { client, token, onSignedIn, onSignInAgain } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [failure, setFailure] = useState<Failure | undefined>(undefined)
  const mounted = useRef(false)
  // The newest handler, read when the answer arrives rather than captured
  // when the request left, so a redraw that hands a new one in never asks the
  // server again.
  const signedIn = useRef(onSignedIn)
  signedIn.current = onSignedIn

  const signIn = useCallback((): void => {
    setFailure(undefined)
    spend(client, token)
      .then(next => {
        if (mounted.current) setFailure(next)
      })
      .catch(() => undefined)
  }, [client, token])

  useEffect(() => {
    mounted.current = true
    const deliver = (session: Session): void => {
      signedIn.current(session)
    }
    deliverTo.set(token, deliver)
    signIn()
    return () => {
      mounted.current = false
      if (deliverTo.get(token) === deliver) deliverTo.delete(token)
    }
  }, [signIn, token])

  return (
    <Screen>
      <Card>
        <View style={styles.body}>
          {failure == null ? (
            <>
              <Text style={styles.title}>Signing you in…</Text>
              <ActivityIndicator color={theme.primaryTextColor} />
              <Button
                kind="text"
                label="Sign in another way"
                onPress={() => {
                  onSignInAgain(false)
                }}
              />
            </>
          ) : failure.kind === 'refused' ? (
            <>
              <Text style={styles.title}>This link can’t be used</Text>
              <Text style={styles.error}>
                This sign-in link is no longer good. It may have expired or
                already been used.
              </Text>
              <Button
                label="Sign in"
                onPress={() => {
                  onSignInAgain(true)
                }}
              />
              <Text style={styles.note}>
                Enter your e-mail address and we’ll send you a new code and
                link.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.title}>Couldn’t sign you in</Text>
              <Text style={styles.error}>{failure.message}</Text>
              {failure.retry && <Button label="Try again" onPress={signIn} />}
              <Button
                kind={failure.retry ? 'secondary' : 'primary'}
                label="Sign in another way"
                onPress={() => {
                  onSignInAgain(false)
                }}
              />
            </>
          )}
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
