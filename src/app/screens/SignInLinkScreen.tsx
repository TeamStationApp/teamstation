import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { Session, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { AnalyticsClient } from '../../common/observability/analyticsClient'
import { Button, Card, Screen } from '../components'
import { analyticsError, useAnalytics } from '../observability/AnalyticsContext'
import { linkDeviceName } from '../platform/signInRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface SignInLinkScreenProps {
  client: TeamStationClient
  token: string
  /**
   * The origin of the server that issued the link, when the link names one:
   * a link mailed to this app's own link host does. Absent, the link is this
   * server's.
   */
  server?: string
  /**
   * The name the link's session is kept under, as a device's is: the
   * installed app's. Absent on the web, which keeps a browser session.
   */
  deviceName?: string
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
  /** Issued by another server than the one this app signs in to. */
  | { kind: 'wrongServer'; server: string; own: string }
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

/**
 * Whether a link that names `server` was issued by the server this client
 * signs in to. The same server can be reached by more than one name — an app
 * built against the API's address gets links naming the site's — so a name
 * that differs is checked against the server's own OpenID issuer, which is
 * `<its public origin>/oauth`. A token is never sent to a server that did not
 * issue it. A server that answers with no issuer vouches for no other name.
 * Undefined when the server could not be asked, which says nothing about whose
 * link it is.
 */
export async function linkIsOurs(
  client: TeamStationClient,
  server: string | undefined
): Promise<boolean | undefined> {
  if (server == null || server === client.serverOrigin()) return true
  const issuer = await client.issuer()
  return issuer === undefined ? undefined : issuer === `${server}/oauth`
}

async function spend(
  client: TeamStationClient,
  token: string,
  server: string | undefined,
  deviceName: string | undefined,
  analytics: AnalyticsClient | undefined
): Promise<Failure | undefined> {
  const known = attempts.get(token)
  if (known != null) return await known
  const emit = analytics?.capture()
  emit?.('login_started', { mt: 'link' })
  const attempt = linkIsOurs(client, server)
    .then(async ours => {
      if (ours === undefined) {
        // Retried, not a refusal: the next try may reach the server.
        throw new Error(
          `Couldn’t reach ${client.serverOrigin()} to check this link. Try again.`
        )
      }
      if (!ours) {
        throw Object.assign(new Error('wrong server'), { wrongServer: true })
      }
      return await client.signInWithLink(token, deviceName)
    })
    .then(
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
        emit?.('login_failed', { mt: 'link', ec: analyticsError(error) })
        if (error instanceof HttpError && error.code === 'unauthorized') {
          return { kind: 'refused' }
        }
        if (
          server != null &&
          error instanceof Error &&
          'wrongServer' in error
        ) {
          // Not cached: a discovery that failed this time may answer the next.
          attempts.delete(token)
          return { kind: 'wrongServer', server, own: client.serverOrigin() }
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
  const {
    client,
    token,
    server,
    deviceName = linkDeviceName,
    onSignedIn,
    onSignInAgain
  } = props
  const analytics = useAnalytics()
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
    spend(client, token, server, deviceName, analytics)
      .then(next => {
        if (mounted.current) setFailure(next)
      })
      .catch(() => undefined)
  }, [client, token, server, deviceName, analytics])

  useEffect(() => {
    mounted.current = true
    const deliver = (session: Session): void => {
      analytics?.identify(session.user.id, client.token)
      analytics?.emit('login_succeeded', { mt: 'link' }).catch(() => {})
      signedIn.current(session)
    }
    deliverTo.set(token, deliver)
    signIn()
    return () => {
      mounted.current = false
      if (deliverTo.get(token) === deliver) deliverTo.delete(token)
    }
  }, [signIn, token, analytics, client])

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
          ) : failure.kind === 'wrongServer' ? (
            <>
              <Text style={styles.title}>This link is for another server</Text>
              <Text style={styles.error}>
                {`This link is for ${failure.server}. This app signs in to ${failure.own}.`}
              </Text>
              <Button
                label="Sign in"
                testID="signInLinkSignIn"
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
