import React, { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { Modal } from '../components/Modal'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AgeEntry } from './AgeEntry'
import type { AgeAnswer } from './AgeGate'
import type { AppleAge } from './declaredAge'

/**
 * The age modal, or the under-13 notice. The modal asks somebody with no age
 * on file for one: their year and month of birth, or that they are 18 or
 * older, which it leaves out when Apple said 13 to 17. The chat rules sit
 * under its buttons, as the age they give accepts them. Closing it, by its
 * close control or the dimmed page, declines for now.
 */
export function AgeSheet(props: {
  mode: 'ask' | 'notice'
  apple: AppleAge
  busy?: boolean
  failed?: boolean
  onAnswer: (body: AgeAnswer) => void
  onDecline: () => void
}): React.ReactElement {
  const {
    mode,
    apple,
    busy = false,
    failed = false,
    onAnswer,
    onDecline
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const notice = mode === 'notice'
  const [entering, setEntering] = useState(false)
  // The notice after an answer under 13 starts again from the choice.
  useEffect(() => {
    if (notice) setEntering(false)
  }, [notice])
  const appleMinor = typeof apple !== 'string' && apple.kind === 'minor'
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDecline}>
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel={
            notice ? lstrings.chat_age_under13_ok : lstrings.chat_age_close
          }
          style={styles.behind}
          onPress={onDecline}
        />
        <View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, theme.rem(1.5)) }
          ]}
          testID="chat-age-sheet"
          accessibilityViewIsModal
        >
          <Text style={styles.title} accessibilityRole="header">
            {notice ? lstrings.chat_age_under13_title : lstrings.chat_age_title}
          </Text>
          {/* At large text sizes the words scroll; the buttons stay in reach. */}
          <ScrollView style={styles.content}>
            <Text style={styles.body}>
              {notice
                ? lstrings.chat_age_under13_body
                : appleMinor
                  ? lstrings.chat_age_body_minor
                  : lstrings.chat_age_body}
            </Text>
            {failed && (
              <Text
                style={[styles.failed, styles.paragraph]}
                accessibilityRole="alert"
              >
                {lstrings.chat_age_failed}
              </Text>
            )}
          </ScrollView>
          {notice ? (
            <Button
              label={lstrings.chat_age_under13_ok}
              block
              testID="chat-age-ok"
              onPress={onDecline}
            />
          ) : entering ? (
            <AgeEntry
              apple={apple}
              busy={busy}
              onSave={birth => {
                onAnswer(birth)
              }}
              onBack={() => {
                setEntering(false)
              }}
            />
          ) : (
            <>
              <Button
                label={lstrings.chat_age_enter}
                block
                disabled={busy}
                testID="chat-age-enter"
                onPress={() => {
                  setEntering(true)
                }}
              />
              {!appleMinor && (
                <Button
                  label={lstrings.chat_age_adult}
                  block
                  busy={busy}
                  disabled={busy}
                  testID="chat-age-adult"
                  onPress={() => {
                    onAnswer({ adult: true })
                  }}
                />
              )}
              <Text style={styles.rules}>{lstrings.chat_age_rules}</Text>
              {/* Never disabled: closing withdraws an answer still saving. */}
              <CancelAction
                label={lstrings.chat_age_close}
                testID="chat-age-close"
                onPress={onDecline}
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
    backgroundColor: theme.cardBackgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    maxHeight: '85%',
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  content: { flexGrow: 0 },
  paragraph: { marginTop: theme.rem(theme.spaceMdRem) },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    lineHeight: theme.rem(1.375),
    color: theme.primaryTextColor
  },
  rules: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    lineHeight: theme.rem(1.2),
    color: theme.secondaryTextColor
  },
  failed: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
