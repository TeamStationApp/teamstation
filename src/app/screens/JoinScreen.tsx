import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type {
  GameStationClient,
  InviteInfo,
  Session,
  SignInWait
} from '../../common/api'
import { Button, Card, Screen, TextField } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { rememberRequest } from './SignInLinkScreen'

export interface JoinScreenProps {
  client: GameStationClient
  /** The code out of `/i/<code>`. */
  code: string
  /** Somebody who was already signed in, so the screen can offer to redeem. */
  signedIn: boolean
  onSignedIn: (session: Session) => void
  /** Go and look at what they have just been let into. */
  onOpen: (scope: InviteInfo['scope']) => void
}

/**
 * The screen an invite link opens.
 *
 * One address, `/i/<code>`, whether the person holding it has an account, is
 * signed in on this machine, or has never heard of GameStation — because a
 * link handed to a parent at a game cannot know which of the three they are.
 *
 * Signed in, it is one button. Not signed in, it is a name and an address and
 * the ordinary sign-in code; the account, if there is none, is made by the
 * server when that code comes back, and the invite is redeemed in the same
 * breath. Nothing here creates an account, which is why an address somebody
 * cannot read gets them nowhere.
 */
export function JoinScreen(props: JoinScreenProps): React.ReactElement {
  const { client, code, signedIn, onOpen, onSignedIn } = props
  const styles = getStyles(useTheme())

  const [info, setInfo] = useState<InviteInfo | undefined>(undefined)
  const [missing, setMissing] = useState(false)
  const [joined, setJoined] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [signInCode, setSignInCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** The sign-in this screen is waiting on, so a link opened elsewhere lands here. */
  const waiting = useRef<SignInWait | undefined>(undefined)

  useEffect(() => {
    let live = true
    client
      .inviteInfo(code)
      .then(answer => {
        if (!live) return
        setInfo(answer)
        setMissing(false)
      })
      .catch(() => {
        if (live) setMissing(true)
      })
    return () => {
      live = false
    }
    // `signedIn` is in here on purpose: signing in changes `alreadyIn`.
  }, [client, code, signedIn])

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

  const accept = (): void => {
    run(async () => {
      await client.redeemInvite(code)
      setJoined(true)
    })
  }

  const sendCode = (): void => {
    run(async () => {
      const wait = await client.requestInviteCode(code, {
        email: email.trim(),
        displayName: name.trim() === '' ? undefined : name.trim()
      })
      waiting.current = wait
      // A request this browser made is a request a person made, so the link
      // in the mail is one tap when it is opened here.
      rememberRequest(wait.requestId)
      setCodeSent(true)
    })
  }

  // The same poll the sign-in screen runs: the link in that e-mail may well be
  // opened on a laptop while this phone is still sitting on the code field.
  useEffect(() => {
    if (!codeSent) return
    let live = true
    const timer = setInterval(() => {
      const wait = waiting.current
      if (wait == null) return
      client
        .claimSignIn(wait)
        .then(session => {
          if (!live || session == null) return
          onSignedIn(session)
          setJoined(true)
        })
        .catch(() => undefined)
    }, 3000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [client, codeSent, onSignedIn])

  const finish = (): void => {
    run(async () => {
      const session = await client.signInWithCode(
        email.trim(),
        signInCode.trim()
      )
      onSignedIn(session)
      setJoined(true)
    })
  }

  if (missing) {
    return (
      <Screen centreContent contentStyle={styles.centre}>
        <Card style={styles.card}>
          <Text style={styles.title}>{lstrings.join_unknown}</Text>
          <Text style={styles.subtitle}>{lstrings.join_unknown_detail}</Text>
        </Card>
      </Screen>
    )
  }

  if (info == null) {
    return (
      <Screen centreContent contentStyle={styles.centre}>
        <Card style={styles.card}>
          <ActivityIndicator />
          <Text style={styles.subtitle}>{lstrings.join_loading}</Text>
        </Card>
      </Screen>
    )
  }

  const offer = sprintf(
    info.scope.kind === 'team'
      ? lstrings.join_scope_team
      : info.scope.kind === 'season'
        ? lstrings.join_scope_season
        : lstrings.join_scope_league,
    info.scope.name
  )

  return (
    <Screen centreContent contentStyle={styles.centre}>
      <Card style={styles.card}>
        <View style={styles.heading}>
          <Text style={styles.title}>{lstrings.join_title}</Text>
          <Text style={styles.subtitle}>{offer}</Text>
        </View>

        {!info.valid && !joined ? (
          <Text style={styles.error}>{lstrings.join_dead}</Text>
        ) : joined ? (
          <>
            <Text style={styles.subtitle}>
              {sprintf(lstrings.join_welcome, info.scope.name)}
            </Text>
            <Button
              label={lstrings.join_open}
              block
              onPress={() => {
                onOpen(info.scope)
              }}
            />
          </>
        ) : info.alreadyIn ? (
          <>
            <Text style={styles.subtitle}>
              {sprintf(lstrings.join_already, info.scope.name)}
            </Text>
            <Button
              label={lstrings.join_open}
              block
              onPress={() => {
                onOpen(info.scope)
              }}
            />
          </>
        ) : info.signedIn ? (
          <Button
            label={lstrings.join_accept}
            block
            busy={busy}
            onPress={accept}
          />
        ) : (
          <>
            <TextField
              label={lstrings.join_name}
              value={name}
              onChangeText={setName}
              placeholder={lstrings.join_name_placeholder}
              autoFocus
            />
            <TextField
              label={lstrings.join_email}
              value={email}
              onChangeText={setEmail}
              placeholder={lstrings.join_email_placeholder}
              keyboardType="email-address"
              autoComplete="email"
              onSubmitEditing={() => {
                if (email.trim().length > 3 && !codeSent) sendCode()
              }}
            />
            {codeSent && (
              <>
                <TextField
                  label={lstrings.join_code}
                  value={signInCode}
                  onChangeText={setSignInCode}
                  placeholder="123456"
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  autoFocus
                  onSubmitEditing={finish}
                />
                <Text style={styles.sent}>{lstrings.join_code_sent}</Text>
              </>
            )}
            <Button
              label={codeSent ? lstrings.join_finish : lstrings.join_send_code}
              block
              busy={busy}
              disabled={
                codeSent
                  ? signInCode.trim().length < 4
                  : email.trim().length < 4
              }
              onPress={codeSent ? finish : sendCode}
            />
          </>
        )}

        {error != null && <Text style={styles.error}>{error}</Text>}
      </Card>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  centre: {
    // No `flex: 1`: that made the column exactly as tall as the scroll view,
    // so there was never anything to scroll and the keyboard could cover the
    // card with no way back. `Screen`'s `centreContent` does the centring.
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
