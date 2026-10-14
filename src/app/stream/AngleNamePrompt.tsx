import React, { useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The server's limit on a camera name, counted after trimming. */
export const ANGLE_NAME_MAX = 80
/** The angle strip splits a video's title here, so a name may not contain it. */
const SEPARATOR = ' — '

/**
 * What is wrong with a typed name by the server's label rules, or null when
 * it may be sent. An empty name is not wrong, only not ready: Start waits.
 */
export function angleNameProblem(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length > ANGLE_NAME_MAX)
    return sprintf(lstrings.stream_prompt_too_long, ANGLE_NAME_MAX)
  if (trimmed.includes(SEPARATOR)) return lstrings.stream_prompt_separator
  return null
}

/** One-word angles the prompt offers, in the order they are shown. */
export function angleSuggestions(): string[] {
  return [
    lstrings.stream_prompt_suggestion_home,
    lstrings.stream_prompt_suggestion_first,
    lstrings.stream_prompt_suggestion_third,
    lstrings.stream_prompt_suggestion_dugout
  ]
}

/** The name to send, or undefined while there is none that may be sent. */
export function angleNameToSend(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '' || angleNameProblem(raw) != null) return undefined
  return trimmed
}

export interface AngleNamePromptProps {
  visible: boolean
  onCancel: () => void
  /**
   * Asks the server for this phone's stream under the name. A rejection is
   * shown under the field, as the server worded it: "You already have a
   * camera called Home Plate on this game".
   */
  onStart: (name: string) => Promise<void>
  /** Once the prompt has gone from the screen (iOS), so another modal may open. */
  onDismiss?: () => void
}

/**
 * "Name this camera angle": what Record video asks before it opens the
 * camera. The name is how the game's viewers tell this angle from the others.
 * The field opens the keyboard at once, so the prompt rises above it, Cancel
 * and Start whole, the way `PickerDialog` does; and when the window left over
 * is too short for all of it, it scrolls, and a tap on a button while the
 * keyboard is up reaches the button.
 */
export function AngleNamePrompt(
  props: AngleNamePromptProps
): React.ReactElement {
  const { visible, onCancel, onStart, onDismiss } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | undefined>(undefined)

  const problem = angleNameProblem(name)
  const toSend = angleNameToSend(name)
  const start = (): void => {
    if (toSend == null || busy) return
    setBusy(true)
    setRefused(undefined)
    onStart(toSend).then(
      () => {
        setBusy(false)
      },
      (error: unknown) => {
        setBusy(false)
        setRefused(
          error instanceof Error ? error.message : lstrings.common_retry
        )
      }
    )
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onCancel}
      onDismiss={onDismiss}
    >
      <KeyboardAvoidingView
        style={styles.scrim}
        // Android draws the modal's window edge to edge, and that window does
        // not shrink for the keyboard, so the view shrinks itself (`height`),
        // as `PickerDialog` does; iOS pads by the keyboard's height.
        behavior={
          Platform.OS === 'ios'
            ? 'padding'
            : Platform.OS === 'android'
              ? 'height'
              : undefined
        }
      >
        <Pressable
          style={styles.behind}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={lstrings.stream_prompt_cancel}
        />
        <ScrollView
          style={styles.sheet}
          contentContainerStyle={styles.sheetContent}
          keyboardShouldPersistTaps="handled"
          testID="angle-name-prompt"
        >
          <Text style={styles.title}>{lstrings.stream_prompt_title}</Text>
          <TextField
            label={lstrings.stream_prompt_label}
            value={name}
            onChangeText={text => {
              setName(text)
              setRefused(undefined)
            }}
            placeholder={lstrings.stream_prompt_placeholder}
            autoFocus
            autoCapitalize="words"
            // A phone may be held sideways already, ready to film.
            disableFullscreenUI
            error={problem ?? refused}
            onSubmitEditing={start}
          />
          <View style={styles.suggestions}>
            {angleSuggestions().map(label => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={label}
                testID={`angle-suggestion-${label}`}
                style={styles.suggestion}
                onPress={() => {
                  setName(label)
                  setRefused(undefined)
                }}
              >
                <Text style={styles.suggestionText}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.buttons}>
            <Button
              label={lstrings.stream_prompt_cancel}
              kind="text"
              onPress={onCancel}
            />
            <Button
              label={lstrings.stream_prompt_start}
              disabled={toSend == null}
              busy={busy}
              onPress={start}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.overlayBackgroundColor,
    padding: theme.rem(theme.spaceMdRem)
  },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  sheet: {
    flexGrow: 0,
    width: '100%',
    maxWidth: theme.rem(24),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.cardBackgroundColor
  },
  sheetContent: {
    padding: theme.rem(theme.spaceMdRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '600'
  },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceSmRem)
  },
  suggestion: {
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.375),
    borderRadius: theme.rem(1),
    backgroundColor: theme.inactiveBackgroundColor
  },
  suggestionText: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600'
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  }
}))
