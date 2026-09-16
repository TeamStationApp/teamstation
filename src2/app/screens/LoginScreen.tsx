import React, { useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'

import type { GameStationClient, Session } from '../../common/api'
import { HttpError } from '../../common/errors'
import { lstrings } from '../locales/strings'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'

export interface LoginScreenProps {
  client: GameStationClient
  onSignedIn: (session: Session) => void
}

/**
 * Two ways in: a password, or a code by e-mail. The code screen only appears
 * once a code has actually been asked for, so nobody is told to check their
 * inbox for something that was never sent.
 */
export function LoginScreen(props: LoginScreenProps): React.ReactElement {
  const { client, onSignedIn } = props
  const styles = getStyles(useTheme())
  const theme = useTheme()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    setError(undefined)
    work()
      .catch((caught: unknown) => {
        setError(
          caught instanceof HttpError ? caught.message : lstrings.common_retry
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const signInWithPassword = (): void => {
    run(async () => {
      onSignedIn(await client.signInWithPassword(email, password))
    })
  }

  const askForCode = (): void => {
    run(async () => {
      await client.requestEmailCode(email)
      setCodeSent(true)
    })
  }

  const signInWithCode = (): void => {
    run(async () => {
      onSignedIn(await client.signInWithCode(email, code))
    })
  }

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>{lstrings.login_title}</Text>

        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder={lstrings.login_email}
          placeholderTextColor={theme.placeholderTextColor}
          autoCapitalize="none"
          keyboardType="email-address"
          inputMode="email"
        />

        {codeSent ? (
          <>
            <Text style={styles.hint}>{lstrings.login_code_sent}</Text>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={setCode}
              placeholder={lstrings.login_code}
              placeholderTextColor={theme.placeholderTextColor}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={6}
            />
            <Pressable
              style={styles.primaryButton}
              onPress={signInWithCode}
              disabled={busy}
            >
              <Text style={styles.primaryButtonText}>
                {lstrings.login_submit}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder={lstrings.login_password}
              placeholderTextColor={theme.placeholderTextColor}
              secureTextEntry
            />
            <Pressable
              style={styles.primaryButton}
              onPress={signInWithPassword}
              disabled={busy}
            >
              <Text style={styles.primaryButtonText}>
                {lstrings.login_submit}
              </Text>
            </Pressable>
            <Pressable onPress={askForCode} disabled={busy}>
              <Text style={styles.linkText}>{lstrings.login_send_code}</Text>
            </Pressable>
          </>
        )}

        {busy ? <ActivityIndicator color={theme.primaryTextColor} /> : null}
        {error != null ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.backgroundColor,
      padding: theme.rem(1)
    },
    card: {
      width: '100%',
      maxWidth: theme.rem(22),
      backgroundColor: theme.cardBackgroundDark,
      borderRadius: theme.rem(0.5),
      padding: theme.rem(1.25),
      gap: theme.rem(0.75)
    },
    title: {
      color: theme.primaryTextColor,
      fontFamily: theme.primaryTextFont,
      fontSize: theme.rem(theme.primaryTextFontSizeRem),
      marginBottom: theme.rem(0.5)
    },
    input: {
      backgroundColor: theme.inputBackgroundColor,
      borderColor: theme.inputBorderColor,
      borderWidth: 1,
      borderRadius: theme.rem(0.35),
      color: theme.inputTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      paddingHorizontal: theme.rem(0.65),
      paddingVertical: theme.rem(0.55)
    },
    primaryButton: {
      alignItems: 'center',
      backgroundColor: theme.primaryButtonColor,
      borderRadius: theme.rem(0.35),
      paddingVertical: theme.rem(0.65)
    },
    primaryButtonText: {
      color: theme.buttonTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1)
    },
    linkText: {
      color: theme.clearButtonColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9),
      textAlign: 'center'
    },
    hint: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9)
    },
    error: {
      color: theme.dangerColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9)
    }
  })
)
