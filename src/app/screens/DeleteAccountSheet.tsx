import React, { useRef, useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { Button } from '../components'
import { lstrings } from '../locales/strings'
import { SlideToStop } from '../stream/overlay/SlideToStop'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface DeleteAccountSheetProps {
  client: TeamStationClient
  onCancel: () => void
  /** The account is gone, or the session that would delete it: sign in. */
  onLeave: () => void
}

/**
 * Deleting an account cannot be undone, so it takes a slide, not a tap: the
 * same red track that stops a recording, under the warning, with Cancel as a
 * blue pill beneath it. A failed delete says so and the track comes back. A
 * session that has ended cannot say whether the delete went through, so the
 * sheet says only that, and that signing in again finishes it either way.
 */
export function DeleteAccountSheet(
  props: DeleteAccountSheetProps
): React.ReactElement {
  const { client, onCancel, onLeave } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [ended, setEnded] = useState(false)
  // Why the server refused, under the failure itself, when it said.
  const [error, setError] = useState('')
  // A new key puts the knob back at the start after a failure.
  const [attempt, setAttempt] = useState(0)
  const working = useRef(false)

  const cancel = (): void => {
    if (working.current) return
    if (ended) onLeave()
    else onCancel()
  }
  const remove = (): void => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setFailed(false)
    setError('')
    client.deleteAccount().then(
      () => {
        working.current = false
        onLeave()
      },
      (failure: unknown) => {
        working.current = false
        setBusy(false)
        // Refused for want of a session: either this delete went through and
        // its answer was lost, or the session ended before it. Signing in
        // again tells them apart, since a deleted account's addresses no
        // longer reach it.
        if (failure instanceof HttpError && failure.code === 'unauthorized') {
          setEnded(true)
          return
        }
        setAttempt(value => value + 1)
        setError(failure instanceof Error ? failure.message : '')
        setFailed(true)
      }
    )
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={cancel}>
      <View style={styles.scrim}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.account_delete_cancel}
          disabled={busy}
          style={styles.behind}
          onPress={cancel}
        />
        <View style={styles.sheet} accessibilityLabel={lstrings.account_delete}>
          <Text style={styles.message}>{lstrings.account_delete_confirm}</Text>
          {ended && (
            <Text accessibilityRole="alert" style={styles.error}>
              {lstrings.account_delete_session_ended}
            </Text>
          )}
          {failed && (
            <Text accessibilityRole="alert" style={styles.error}>
              {lstrings.account_delete_failed}
              {error === '' ? '' : `\n${error}`}
            </Text>
          )}
          {ended ? (
            <Button
              testID="delete-account-sign-in"
              label={lstrings.account_delete_sign_in}
              color={theme.linkTextColor}
              textColor="#FFFFFF"
              style={styles.cancel}
              onPress={onLeave}
            />
          ) : (
            <>
              <View style={[styles.slide, busy && styles.busy]}>
                <SlideToStop
                  key={attempt}
                  testID="delete-account-slide"
                  label={lstrings.account_delete_slide}
                  glyph="chevron"
                  onStop={remove}
                />
              </View>
              <Button
                testID="delete-account-cancel"
                label={lstrings.account_delete_cancel}
                color={theme.linkTextColor}
                textColor="#FFFFFF"
                disabled={busy}
                style={styles.cancel}
                onPress={cancel}
              />
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    alignItems: 'center',
    backgroundColor: theme.cardBackgroundColor,
    padding: theme.rem(1.25),
    paddingBottom: theme.rem(2),
    gap: theme.rem(1),
    borderTopLeftRadius: theme.rem(1),
    borderTopRightRadius: theme.rem(1)
  },
  message: {
    alignSelf: 'stretch',
    textAlign: 'center',
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    lineHeight: theme.rem(1.6)
  },
  error: { color: theme.dangerColor, textAlign: 'center' },
  slide: { marginTop: theme.rem(0.5) },
  busy: { opacity: 0.5, pointerEvents: 'none' },
  cancel: { alignSelf: 'center' }
}))
