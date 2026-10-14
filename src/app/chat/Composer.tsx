import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Platform, Pressable, Text, TextInput, View } from 'react-native'

import { Icon } from '../components'
import { GlassView } from '../components/GlassView'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { sendAllowed } from './chatComposeModel'
import type { PickedFile, PickSource } from './chatFileTypes'
import {
  type ComposerChange,
  type ComposerSelection,
  textEdit
} from './chatMentionsModel'
import { bindComposerKeys, setComposerSelection } from './chatWebInteractions'
import { EmojiPicker } from './EmojiPicker'

export interface ComposerProps {
  text: string
  onText: (text: string, change?: ComposerChange) => void
  /** Off while history is locked: the composer shows, but takes nothing. */
  enabled: boolean
  sending: boolean
  preparing?: boolean
  /** "Replying to <name>" with its snippet, or the edit being made. */
  context:
    | { kind: 'reply'; name: string; snippet: string }
    | { kind: 'edit' }
    | undefined
  onCancelContext: () => void
  attachments: PickedFile[]
  onRemoveAttachment: (index: number) => void
  /** Where Attach can pick from; none hides it (an edit takes no files). */
  sources: PickSource[]
  onAttach: (source: PickSource) => void
  onSend: () => void
  onRead?: () => void
  onOverlay?: (open: boolean) => void
  /** Register a synchronous user-action focus handoff, scoped to this mount. */
  registerFocus?: (focus: (selection?: ComposerSelection) => void) => () => void
}

/**
 * Where a message is written: the words, an emoji picker, an attachment
 * button (photos and files on a phone, the file picker in a browser) with a
 * chip for each picked file, and a chip for the message being replied to or
 * edited.
 */
export function Composer(props: ComposerProps): React.ReactElement {
  const {
    text,
    onText,
    enabled,
    sending,
    context,
    attachments,
    registerFocus,
    onOverlay
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [emoji, setEmoji] = useState(false)
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    onOverlay?.(emoji || choosing)
    return () => {
      onOverlay?.(false)
    }
  }, [emoji, choosing, onOverlay])
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  const selection = useRef<ComposerSelection>({
    start: text.length,
    end: text.length
  })
  const editKey = useRef<string | undefined>(undefined)
  const pendingCaret = useRef<ComposerSelection | undefined>(undefined)
  const [caretRevision, setCaretRevision] = useState(0)
  const latest = useRef(props)
  latest.current = { ...props, onAttach: props.onAttach }
  const canSend = sendAllowed({
    enabled,
    sending,
    preparing: props.preparing === true,
    text,
    attachments
  })
  const canAttach = enabled && !sending && props.preparing !== true
  useEffect(
    () =>
      registerFocus?.(caret => {
        if (!latest.current.enabled) return
        const field = input.current
        // Android keeps a field focused after Back hides its keyboard, and
        // focusing it again shows nothing; refocusing brings the keyboard back.
        if (Platform.OS === 'android' && field?.isFocused() === true)
          field.blur()
        field?.focus()
        if (caret != null) {
          pendingCaret.current = caret
          setCaretRevision(value => value + 1)
        }
      }),
    [registerFocus]
  )
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret == null || !enabled) return
    pendingCaret.current = undefined
    selection.current = caret
    setComposerSelection(input.current, caret)
  }, [text, enabled, caretRevision])
  useEffect(
    () =>
      bindComposerKeys(input.current, () => {
        const current = latest.current
        if (
          sendAllowed({
            enabled: current.enabled,
            sending: current.sending,
            preparing: current.preparing === true,
            text: current.text,
            attachments: current.attachments
          })
        )
          current.onSend()
      }),
    []
  )

  const attach = (source: PickSource): void => {
    const current = latest.current
    if (!current.enabled || current.sending || current.preparing === true)
      return
    setChoosing(false)
    current.onAttach(source)
  }

  return (
    <GlassView radius={theme.rem(1.5)} style={styles.composer}>
      {context != null && (
        <View style={styles.chip}>
          <View style={styles.chipText}>
            <Text style={styles.chipTitle}>
              {context.kind === 'reply'
                ? sprintf(lstrings.chat_replying_to, context.name)
                : lstrings.chat_editing}
            </Text>
            {context.kind === 'reply' && (
              <Text style={styles.chipDetail} numberOfLines={1}>
                {context.snippet}
              </Text>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              context.kind === 'reply'
                ? lstrings.chat_cancel_reply
                : lstrings.chat_cancel_edit
            }
            onPress={props.onCancelContext}
            style={styles.chipClose}
          >
            <Icon name="close" size={1} color={theme.secondaryTextColor} />
          </Pressable>
        </View>
      )}
      {attachments.length > 0 && (
        <View style={styles.files}>
          {attachments.map((file, index) => (
            <View
              key={`${file.fileName}-${index}`}
              testID="chat-attachment-chip"
              style={styles.file}
            >
              <Icon
                name="attach_file"
                size={0.875}
                color={theme.secondaryTextColor}
              />
              <Text style={styles.fileName} numberOfLines={1}>
                {file.fileName}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sprintf(
                  lstrings.chat_remove_attachment,
                  file.fileName
                )}
                onPress={() => {
                  props.onRemoveAttachment(index)
                }}
              >
                <Icon
                  name="close"
                  size={0.875}
                  color={theme.secondaryTextColor}
                />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {choosing && (
        <View style={styles.sources}>
          {props.sources.map(source => (
            <Pressable
              key={source}
              disabled={!canAttach}
              accessibilityState={{ disabled: !canAttach }}
              accessibilityRole="button"
              accessibilityLabel={
                source === 'photos'
                  ? lstrings.chat_photo_library
                  : lstrings.chat_file
              }
              onPress={() => {
                attach(source)
              }}
              style={({ pressed }) => [
                styles.source,
                pressed && styles.pressed
              ]}
            >
              <Text style={styles.sourceText}>
                {source === 'photos'
                  ? lstrings.chat_photo_library
                  : lstrings.chat_file}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.chat_cancel}
            onPress={() => {
              setChoosing(false)
            }}
            style={({ pressed }) => [styles.source, pressed && styles.pressed]}
          >
            <Text style={styles.sourceText}>{lstrings.chat_cancel}</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.row}>
        {props.sources.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.chat_attach}
            accessibilityState={{ disabled: !canAttach }}
            disabled={!canAttach}
            onPress={() => {
              // One place to pick from opens it at once; two ask which.
              if (props.sources.length === 1) attach(props.sources[0])
              else setChoosing(current => !current)
            }}
            style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
          >
            <Icon
              name="attach_file"
              color={
                canAttach ? theme.primaryTextColor : theme.tertiaryTextColor
              }
            />
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_emoji}
          accessibilityState={{ disabled: !enabled, expanded: emoji }}
          disabled={!enabled}
          onPress={() => {
            setEmoji(current => !current)
          }}
          style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
        >
          <Icon
            name="mood"
            color={enabled ? theme.primaryTextColor : theme.tertiaryTextColor}
          />
        </Pressable>
        <TextInput
          ref={input}
          onFocus={props.onRead}
          testID="chat-composer"
          accessibilityLabel={lstrings.chat_composer}
          value={text}
          onSelectionChange={event => {
            selection.current = event.nativeEvent.selection
          }}
          onKeyPress={event => {
            editKey.current = event.nativeEvent.key
          }}
          onChangeText={next => {
            const change = {
              selection: selection.current,
              key: editKey.current
            }
            editKey.current = undefined
            const edit = textEdit(latest.current.text, next, change)
            selection.current = { start: edit.afterEnd, end: edit.afterEnd }
            onText(next, change)
          }}
          editable={enabled}
          multiline
          placeholder={
            enabled ? lstrings.chat_composer : lstrings.chat_composer_locked
          }
          placeholderTextColor={theme.placeholderTextColor}
          style={[styles.input, !enabled && styles.inputOff]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_send}
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={props.onSend}
          style={({ pressed }) => [
            styles.send,
            !canSend && styles.sendOff,
            pressed && styles.pressed
          ]}
        >
          <Icon
            name="send"
            color={canSend ? theme.buttonTextColor : theme.tertiaryTextColor}
          />
        </Pressable>
      </View>
      {emoji && (
        <EmojiPicker
          onPick={picked => {
            onText(text + picked, {
              selection: { start: text.length, end: text.length }
            })
          }}
          onClose={() => {
            setEmoji(false)
          }}
        />
      )}
    </GlassView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  composer: {
    gap: theme.rem(theme.spaceXsRem),
    paddingVertical: theme.rem(theme.spaceXsRem),
    borderWidth: 1,
    borderColor: theme.glassBorderColor,
    borderRadius: theme.rem(1.5)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.rem(0.25)
  },
  icon: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(1.25)
  },
  pressed: {
    opacity: 0.6
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: theme.rem(2.75),
    maxHeight: theme.rem(8),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    borderRadius: theme.rem(1.25),
    backgroundColor: 'transparent',
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    paddingHorizontal: theme.rem(0.875),
    paddingTop: theme.rem(0.5),
    paddingBottom: theme.rem(0.5)
  },
  inputOff: {
    backgroundColor: theme.inactiveBackgroundColor
  },
  send: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(1.25),
    backgroundColor: theme.primaryButtonColor
  },
  sendOff: {
    backgroundColor: theme.inactiveBackgroundColor
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    borderLeftWidth: 3,
    borderLeftColor: theme.activeColor,
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.rem(theme.radiusSmallRem),
    paddingHorizontal: theme.rem(0.625),
    paddingVertical: theme.rem(0.375)
  },
  chipText: {
    flex: 1
  },
  chipTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600',
    color: theme.activeColor
  },
  chipDetail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  chipClose: {
    padding: theme.rem(0.25)
  },
  files: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceXsRem)
  },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.25),
    maxWidth: theme.rem(14),
    borderRadius: theme.rem(1),
    backgroundColor: theme.containerBackgroundColor,
    paddingHorizontal: theme.rem(0.625),
    paddingVertical: theme.rem(0.25)
  },
  fileName: {
    flexShrink: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  },
  sources: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceXsRem)
  },
  source: {
    borderRadius: theme.rem(1),
    backgroundColor: theme.pillBackground,
    paddingHorizontal: theme.rem(0.875),
    paddingVertical: theme.rem(0.5)
  },
  sourceText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.pillTextColor
  }
}))
