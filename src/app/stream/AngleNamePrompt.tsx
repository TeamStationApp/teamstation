import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  Text,
  type TextInput,
  View
} from 'react-native'

import { ListCard } from '../components/ListCard'
import { ListRow } from '../components/ListRow'
import { StreamGlyph } from '../components/StreamGlyph'
import { TextField } from '../components/TextField'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { SheetModal } from './SheetModal'

/** The server's limit on a camera name, counted after trimming. */
export const ANGLE_NAME_MAX = 80
/** The angle strip splits a video's title here, so a name may not contain it. */
const SEPARATOR = ' — '

/**
 * What is wrong with a typed name by the server's label rules, or null when
 * it may be sent. An empty name is not wrong, only not ready: the rows wait.
 */
export function angleNameProblem(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length > ANGLE_NAME_MAX)
    return sprintf(lstrings.stream_prompt_too_long, ANGLE_NAME_MAX)
  if (trimmed.includes(SEPARATOR)) return lstrings.stream_prompt_separator
  return null
}

/**
 * How long Android waits, after focusing the field as the prompt shows, to
 * ask again for a keyboard that has not come up; and how many times.
 */
export const KEYBOARD_RETRY_MS = 300
export const KEYBOARD_RETRIES = 3

/** One-word angles the prompt offers, in the order they are shown. */
export function angleSuggestions(): string[] {
  return [
    lstrings.stream_prompt_suggestion_home,
    lstrings.stream_prompt_suggestion_first,
    lstrings.stream_prompt_suggestion_third,
    lstrings.stream_prompt_suggestion_backstop
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
   * Record with this phone: asks the server for this phone's stream under the
   * name. A rejection is shown under the field, as the server worded it: "You
   * already have a camera called Home Plate on this game".
   */
  onStart: (name: string) => Promise<void>
  /** Use external camera, with the name. */
  onExternal?: (name: string) => void
  /** A phone that cannot record has no "Record with this phone". */
  canRecord?: boolean
  /** Only this phone: no "Use external camera". */
  phoneOnly?: boolean
  /** Once the prompt has gone from the screen (iOS), so another modal may open. */
  onDismiss?: () => void
}

/**
 * The sheet Record Video slides up: a name for the angle, how the game's
 * viewers tell it from the others, then this phone or an external camera. The
 * field opens the keyboard at once, so the sheet rises above it with its rows
 * whole; when the window left over is too short for all of it, it scrolls, and
 * a tap on a row while the keyboard is up reaches the row.
 */
export function AngleNamePrompt(
  props: AngleNamePromptProps
): React.ReactElement {
  const {
    visible,
    onCancel,
    onStart,
    onExternal,
    canRecord = true,
    phoneOnly = false,
    onDismiss
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const field = useRef<React.ComponentRef<typeof TextInput>>(null)
  // `autoFocus` raises the keyboard on iOS. On Android a modal is a dialog
  // with a window of its own, and a field focused before that window has
  // focus shows its cursor but no keyboard, even when the dialog says it is
  // shown. So Android focuses the field as the dialog shows, and while no
  // keyboard has come up, focuses it afresh a moment later, a few times.
  const focusOnShow = Platform.OS === 'android'
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(retry.current)
    },
    []
  )
  const raiseKeyboard = (triesLeft: number): void => {
    field.current?.focus()
    clearTimeout(retry.current)
    if (triesLeft <= 0) return
    retry.current = setTimeout(() => {
      if (Keyboard.isVisible()) return
      field.current?.blur()
      raiseKeyboard(triesLeft - 1)
    }, KEYBOARD_RETRY_MS)
  }

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
    <SheetModal
      visible={visible}
      title={lstrings.stream_prompt_title}
      cancelLabel={lstrings.stream_prompt_cancel}
      onClose={onCancel}
      onDismiss={onDismiss}
      onShow={() => {
        if (focusOnShow) raiseKeyboard(KEYBOARD_RETRIES)
      }}
      testID="angle-name-prompt"
    >
      <TextField
        label={lstrings.stream_prompt_label}
        value={name}
        onChangeText={text => {
          setName(text)
          setRefused(undefined)
        }}
        placeholder={lstrings.stream_prompt_placeholder}
        inputRef={field}
        autoFocus={!focusOnShow}
        autoCapitalize="words"
        // A phone may be held sideways already, ready to film.
        disableFullscreenUI
        error={problem ?? refused}
      />
      <View style={styles.suggestions}>
        {angleSuggestions().map(label => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityLabel={label}
            testID={`angle-suggestion-${label}`}
            hitSlop={6}
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
      <ListCard>
        {canRecord && (
          <ListRow
            testID="record-with-phone"
            leading={
              <StreamGlyph
                name="sidewaysPhone"
                color={theme.primaryTextColor}
              />
            }
            title={lstrings.stream_prompt_phone}
            disabled={toSend == null || busy}
            muted={toSend == null}
            end={busy ? <ActivityIndicator /> : undefined}
            onPress={start}
          />
        )}
        {!phoneOnly && (
          <ListRow
            testID="use-external-camera"
            leading={
              <StreamGlyph name="filmCamera" color={theme.primaryTextColor} />
            }
            title={lstrings.stream_prompt_external}
            disabled={toSend == null || busy}
            muted={toSend == null}
            onPress={() => {
              if (toSend == null) return
              Keyboard.dismiss()
              onExternal?.(toSend)
            }}
          />
        )}
      </ListCard>
    </SheetModal>
  )
}

const SUGGESTION_HEIGHT_REM = 2

const getStyles = cacheStyles((theme: Theme) => ({
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceSmRem)
  },
  suggestion: {
    height: theme.rem(SUGGESTION_HEIGHT_REM),
    justifyContent: 'center',
    paddingHorizontal: pillPadding(theme.rem(SUGGESTION_HEIGHT_REM)),
    borderRadius: theme.rem(SUGGESTION_HEIGHT_REM) / 2,
    backgroundColor: theme.secondaryButtonColor
  },
  suggestionText: {
    color: theme.secondaryButtonTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600'
  }
}))
