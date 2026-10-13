import React, { useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

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
      <View style={styles.scrim}>
        <Pressable
          style={styles.behind}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={lstrings.stream_prompt_cancel}
        />
        <View style={styles.sheet} testID="angle-name-prompt">
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
            // A phone may be held sideways already, ready to film.
            disableFullscreenUI
            error={problem ?? refused}
            onSubmitEditing={start}
          />
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
        </View>
      </View>
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
    width: '100%',
    maxWidth: theme.rem(24),
    padding: theme.rem(theme.spaceMdRem),
    gap: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.cardBackgroundColor
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '600'
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  }
}))
