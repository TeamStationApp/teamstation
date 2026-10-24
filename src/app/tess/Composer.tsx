import React, { type ReactNode, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  type TextInputKeyPressEvent,
  View
} from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AttachPicker } from './AttachPicker'
import { AttachmentChip } from './TessMessage'
import type { TessAttachmentRef, TessUpload } from './tessTypes'

export interface ComposerProps {
  /** Answers whether it was sent; a failed send gives the draft back. */
  onSend: (text: string, attachments: TessAttachmentRef[]) => Promise<boolean>
  onUpload: (upload: TessUpload) => Promise<TessAttachmentRef | null>
  onError: (message: string) => void
  /** Tess is still answering the last message. */
  busy: boolean
  error?: string | null
  /** The push-to-talk button, at the bottom center. */
  mic?: ReactNode
}

/**
 * Where the user writes to Tess: + on the left, the field, send on the
 * right, the attached files above, any error below, and the microphone
 * centered under it all. On the web Enter sends and Shift+Enter starts a new
 * line.
 */
export function Composer({
  onSend,
  onUpload,
  onError,
  busy,
  error,
  mic
}: ComposerProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<TessAttachmentRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [attaching, setAttaching] = useState(false)
  const draft = useRef({ text, attachments })
  draft.current = { text, attachments }

  const ready =
    !busy && uploading === 0 && (text.trim() !== '' || attachments.length > 0)

  const send = (): void => {
    if (!ready) return
    const sent = draft.current
    setText('')
    setAttachments([])
    onSend(sent.text.trim(), sent.attachments).then(
      delivered => {
        if (delivered) return
        setText(current => (current === '' ? sent.text : current))
        setAttachments(current => [...sent.attachments, ...current])
      },
      () => undefined
    )
  }

  const attach = (upload: TessUpload): void => {
    setUploading(count => count + 1)
    onUpload(upload)
      .then(
        attachment => {
          if (attachment != null)
            setAttachments(current => [...current, attachment])
        },
        () => undefined
      )
      .finally(() => {
        setUploading(count => count - 1)
      })
  }

  const keyPress = (event: TextInputKeyPressEvent): void => {
    if (Platform.OS !== 'web') return
    const key = event.nativeEvent as TextInputKeyPressEvent['nativeEvent'] & {
      shiftKey?: boolean
      isComposing?: boolean
    }
    if (key.key !== 'Enter' || key.shiftKey === true) return
    if (key.isComposing === true) return
    event.preventDefault()
    send()
  }

  return (
    <View testID="Tess composer" style={styles.composer}>
      {attaching && (
        <AttachPicker
          onAttach={attach}
          onError={onError}
          onClose={() => {
            setAttaching(false)
          }}
        />
      )}
      {(attachments.length > 0 || uploading > 0) && (
        <View style={styles.chips}>
          {attachments.map(attachment => (
            <AttachmentChip key={attachment.id} attachment={attachment}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sprintf(
                  lstrings.tess_attach_remove,
                  attachment.name
                )}
                hitSlop={12}
                onPress={() => {
                  setAttachments(current =>
                    current.filter(item => item.id !== attachment.id)
                  )
                }}
              >
                <Icon name="close" size={1} color={theme.secondaryTextColor} />
              </Pressable>
            </AttachmentChip>
          ))}
          {uploading > 0 && (
            <View style={styles.uploading}>
              <ActivityIndicator size="small" />
              <Text style={styles.note}>{lstrings.tess_attaching}</Text>
            </View>
          )}
        </View>
      )}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.tess_attach}
          aria-expanded={attaching}
          onPress={() => {
            setAttaching(open => !open)
          }}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
        >
          <Icon name="add" size={1.5} />
        </Pressable>
        <TextInput
          testID="Tess field"
          accessibilityLabel={lstrings.tess_placeholder}
          placeholder={lstrings.tess_placeholder}
          placeholderTextColor={theme.placeholderTextColor}
          multiline
          value={text}
          onChangeText={setText}
          onKeyPress={keyPress}
          style={styles.field}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.tess_send}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={send}
          style={({ pressed }) => [
            styles.round,
            styles.send,
            !ready && styles.disabled,
            pressed && styles.pressed
          ]}
        >
          <Icon name="send" size={1.25} color={theme.buttonTextColor} />
        </Pressable>
      </View>
      {error != null && error !== '' && (
        <Text
          testID="Tess error"
          accessibilityLiveRegion="polite"
          style={styles.error}
        >
          {error}
        </Text>
      )}
      {mic != null && <View style={styles.mic}>{mic}</View>}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  composer: {
    gap: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem),
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor,
    backgroundColor: theme.backgroundColor
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  uploading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.rem(theme.spaceSmRem)
  },
  round: {
    width: theme.rem(3),
    height: theme.rem(3),
    borderRadius: theme.rem(1.5),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.pillBackground
  },
  send: { backgroundColor: theme.primaryButtonColor },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
  field: {
    flex: 1,
    minHeight: theme.rem(3),
    maxHeight: theme.rem(9),
    paddingHorizontal: pillPadding(theme.rem(3)),
    paddingTop: theme.rem(0.8),
    paddingBottom: theme.rem(0.8),
    borderRadius: theme.rem(1.5),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  },
  // Room above the button for its status, which sits over it.
  mic: { alignItems: 'center', paddingTop: theme.rem(theme.spaceLgRem) }
}))
