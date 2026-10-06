import React, { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import { Icon } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { PickedFile, PickSource } from './chatFileTypes'
import { EmojiPicker } from './EmojiPicker'

export interface ComposerProps {
  text: string
  onText: (text: string) => void
  /** Off while history is locked: the composer shows, but takes nothing. */
  enabled: boolean
  sending: boolean
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
}

/**
 * Where a message is written: the words, an emoji picker, an attachment
 * button (photos and files on a phone, the file picker in a browser) with a
 * chip for each picked file, and a chip for the message being replied to or
 * edited.
 */
export function Composer(props: ComposerProps): React.ReactElement {
  const { text, onText, enabled, sending, context, attachments } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [emoji, setEmoji] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const canSend =
    enabled && !sending && (text.trim() !== '' || attachments.length > 0)

  const attach = (source: PickSource): void => {
    setChoosing(false)
    props.onAttach(source)
  }

  return (
    <View style={styles.composer}>
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
            accessibilityState={{ disabled: !enabled }}
            disabled={!enabled}
            onPress={() => {
              // One place to pick from opens it at once; two ask which.
              if (props.sources.length === 1) attach(props.sources[0])
              else setChoosing(current => !current)
            }}
            style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
          >
            <Icon
              name="attach_file"
              color={enabled ? theme.primaryTextColor : theme.tertiaryTextColor}
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
          testID="chat-composer"
          accessibilityLabel={lstrings.chat_composer}
          value={text}
          onChangeText={onText}
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
            onText(text + picked)
          }}
          onClose={() => {
            setEmoji(false)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  composer: {
    gap: theme.rem(theme.spaceXsRem),
    paddingTop: theme.rem(theme.spaceXsRem)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.rem(0.25)
  },
  icon: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(1.25)
  },
  pressed: {
    opacity: 0.6
  },
  input: {
    flex: 1,
    minHeight: theme.rem(2.5),
    maxHeight: theme.rem(8),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    borderRadius: theme.rem(1.25),
    backgroundColor: theme.inputBackgroundColor,
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
    width: theme.rem(2.5),
    height: theme.rem(2.5),
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
