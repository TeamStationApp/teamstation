import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { GameStationClient, Session, SignInWait } from '../../common/api'
import { Button, Card, Screen, TextField } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { rememberRequest } from './SignInLinkScreen'

export interface LoginScreenProps {
  client: GameStationClient
  onSignedIn: (session: Session) => void
}

/** Which of the two ways in the form is currently offering. */
type Method = 'code' | 'password'

/**
 * Sign in.
 *
 * E-mail first, on Paul's instruction and against the drawn design, which put
 * the password field up front with "E-mail me a code instead" underneath. Of
 * the sixty people imported from PeerTube, thirty-four have no password at all
 * — for most of this audience the code *is* the way in, and a password field
 * they cannot fill is an obstacle placed before the thing that works.
 *
 * So: one address field, a large "Send me a sign-in code", and a quieter "Use
 * a password instead" that swaps a password field into the same space and
 * turns the button into "Sign in". Nothing is hidden behind a second screen,
 * and the address typed carries across the swap.
 *
 * The same words come back for an unknown address as for a known one, so the
 * form cannot be used to find out who has an account. The server behaves the
 * same way, including how it counts attempts against a limit.
 */
export function LoginScreen(props: LoginScreenProps): React.ReactElement {
  const { client, onSignedIn } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [method, setMethod] = useState<Method>('code')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  /**
   * The sign-in this screen is waiting on.
   *
   * Kept so that tapping the button in the e-mail on another machine finishes
   * the sign-in here: this client polls with a secret only it holds, and the
   * moment the link is spent anywhere it gets its own session.
   */
  const waiting = useRef<SignInWait | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const run = (work: () => Promise<void>): void => {
    setError(undefined)
    setBusy(true)
    work()
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const sendCode = (): void => {
    run(async () => {
      const wait = await client.requestEmailCode(email.trim(), {
        origin: 'web'
      })
      waiting.current = wait
      // So that the link in the mail, opened in this browser, is one tap: a
      // request this browser made is a request a person made.
      rememberRequest(wait.requestId)
      setCodeSent(true)
    })
  }

  // While the code screen is up, ask every few seconds whether the sign-in has
  // been approved somewhere else — which is what a tap on the e-mail's button
  // from a laptop, or from the phone app, amounts to.
  useEffect(() => {
    if (!codeSent) return
    let live = true
    const timer = setInterval(() => {
      const wait = waiting.current
      if (wait == null) return
      client
        .claimSignIn(wait)
        .then(session => {
          if (live && session != null) onSignedIn(session)
        })
        .catch(() => undefined)
    }, 3000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [client, codeSent, onSignedIn])

  const signInWithCode = (): void => {
    run(async () => {
      onSignedIn(await client.signInWithCode(email.trim(), code.trim()))
    })
  }

  const signInWithPassword = (): void => {
    run(async () => {
      onSignedIn(await client.signInWithPassword(email.trim(), password))
    })
  }

  const canSend = email.trim().length > 3

  return (
    <Screen contentStyle={styles.centre}>
      <Card style={styles.card}>
        <View style={styles.heading}>
          <Text style={styles.title}>Sign in to GameStation</Text>
          <Text style={styles.subtitle}>
            Watch live games, multi-angle replays and follow your teams
          </Text>
        </View>

        <TextField
          label="E-mail address"
          value={email}
          onChangeText={setEmail}
          placeholder="parent@example.com"
          keyboardType="email-address"
          autoComplete="email"
          autoFocus
          // Enter submits, which is what a keyboard's "go" key is for and what
          // anybody who has typed an address into a form expects. Noticed
          // because a browser test pressed it and nothing happened.
          onSubmitEditing={() => {
            if (!canSend) return
            if (method === 'password') signInWithPassword()
            else if (codeSent) signInWithCode()
            else sendCode()
          }}
        />

        {method === 'password' && (
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            secure
            autoComplete="current-password"
            onSubmitEditing={signInWithPassword}
          />
        )}

        {method === 'code' && codeSent && (
          <TextField
            label="Sign-in code"
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            autoFocus
            onSubmitEditing={signInWithCode}
          />
        )}

        {error != null && <Text style={styles.error}>{error}</Text>}

        {method === 'password' ? (
          <Button
            label="Sign in"
            block
            busy={busy}
            disabled={!canSend || password === ''}
            onPress={signInWithPassword}
          />
        ) : codeSent ? (
          <Button
            label="Sign in"
            block
            busy={busy}
            disabled={code.trim().length < 4}
            onPress={signInWithCode}
          />
        ) : (
          <Button
            label="Send me a sign-in code"
            block
            busy={busy}
            disabled={!canSend}
            onPress={sendCode}
          />
        )}

        {method === 'code' && codeSent && (
          <Text style={styles.sent}>
            If that address has an account, a six-digit code is on its way. It
            lasts ten minutes.
          </Text>
        )}

        <Button
          kind="text"
          label={
            method === 'code' ? 'Use a password instead' : 'Use a sign-in code'
          }
          onPress={() => {
            setError(undefined)
            setCodeSent(false)
            setCode('')
            setPassword('')
            setMethod(method === 'code' ? 'password' : 'code')
          }}
        />
      </Card>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  centre: {
    flex: 1,
    justifyContent: 'center',
    maxWidth: theme.rem(28)
  },
  card: {
    gap: theme.rem(theme.spaceLgRem),
    padding: theme.rem(theme.spaceXlRem)
  },
  heading: {
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.75),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.02),
    textAlign: 'center',
    color: theme.primaryTextColor
  },
  subtitle: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    textAlign: 'center',
    color: theme.secondaryTextColor
  },
  sent: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    textAlign: 'center',
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
