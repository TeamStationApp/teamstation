import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  Animated,
  BackHandler,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'

import { Icon } from '../components'
import { ButtonIcon } from '../components/ButtonIcon'
import { useBackOverride } from '../components/headerSlot'
import { useMotionPreference } from '../components/useMotionPreference'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { ChatFileOps } from './AttachmentView'
import { sendAllowed } from './chatComposeModel'
import { ChatComposerRow } from './ChatComposerRow'
import * as platformFiles from './chatFiles'
import type { PickedFile, PickSource } from './chatFileTypes'
import {
  type ComposerChange,
  type ComposerSelection,
  textEdit
} from './chatMentionsModel'
import {
  bindAttachmentMenu,
  bindComposerKeys,
  setComposerSelection,
  sizeComposerText,
  watchComposerWidth
} from './chatWebInteractions'
import { EmojiPicker } from './EmojiPicker'

export type ComposerPicker = 'attachments' | 'emoji' | undefined

export interface ComposerProps {
  text: string
  onText: (text: string, change?: ComposerChange) => void
  /** Off while history is locked: the composer shows, but takes nothing. */
  enabled: boolean
  /** Not on show, sliding off or covered: it takes nothing, and looks as it was. */
  asleep?: boolean
  sending: boolean
  preparing?: boolean
  /** "Replying to <name>" with its snippet, or the edit being made. */
  context:
    | { kind: 'reply'; name: string; snippet: string }
    | { kind: 'edit'; hasAttachments?: boolean; saving?: boolean }
    | undefined
  onCancelContext: () => void
  shortcutsActive?: boolean
  onEditLatest?: () => void
  onInterruptShortcut?: () => void
  files?: Pick<ChatFileOps, 'bytesUri' | 'releaseUri'>
  attachments: PickedFile[]
  onRemoveAttachment: (index: number) => void
  /** Where Attach can pick from; none hides it (an edit takes no files). */
  sources: PickSource[]
  onAttach: (source: PickSource) => void
  onSend: () => void
  onRead?: () => void
  picker: ComposerPicker
  onPickerChange: (picker: ComposerPicker) => void
  onOpenAttachments?: () => void
  attachmentPanelHeight?: number
  returnToKeyboard?: () => void
  returningToKeyboard?: boolean
  /** Register a synchronous user-action focus handoff, scoped to this mount. */
  registerFocus?: (focus: (selection?: ComposerSelection) => void) => () => void
}

function DraftPhoto({
  file,
  files
}: {
  file: PickedFile
  files: Pick<ChatFileOps, 'bytesUri' | 'releaseUri'>
}): React.ReactElement | null {
  const styles = getStyles(useTheme())
  const [preview, setPreview] = useState<{ file: PickedFile; uri: string }>()
  useEffect(() => {
    let live = true
    let made: string | undefined
    files
      .bytesUri(file.bytes, file.contentType, file.fileName)
      .then(uri => {
        if (live) {
          made = uri
          setPreview({ file, uri })
        } else files.releaseUri(uri).catch(() => undefined)
      })
      .catch(() => {})
    return () => {
      live = false
      if (made != null) files.releaseUri(made).catch(() => undefined)
    }
  }, [file, files])
  if (preview?.file !== file) return null
  return (
    <Image
      testID="chat-draft-photo"
      accessibilityLabel={file.fileName}
      source={{ uri: preview.uri }}
      resizeMode="cover"
      style={styles.draftPhoto}
    />
  )
}

/**
 * Where a message is written: the words, an emoji picker, an attachment
 * panel for photos, camera and files on supported devices, with a
 * chip for each picked file, and a chip for the message being replied to or
 * edited.
 */
export function Composer(props: ComposerProps): React.ReactElement {
  const {
    text,
    onText,
    onAttach,
    enabled,
    sending,
    context,
    attachments,
    registerFocus,
    picker,
    onPickerChange: setPicker
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const web = Platform.OS === 'web'
  const emoji = web && picker === 'emoji'
  const choosing = picker === 'attachments'
  const takes = enabled && props.asleep !== true
  const canAttach =
    takes && !sending && props.preparing !== true && context?.kind !== 'edit'
  const closePickers = useCallback(() => {
    setPicker(undefined)
  }, [setPicker])
  useEffect(() => {
    if (!takes || context?.kind === 'edit' || (choosing && !canAttach))
      closePickers()
  }, [takes, context?.kind, choosing, canAttach, closePickers])
  // A permission change or a conversation switch can unmount this field
  // while its parent stays on screen. Release the picker owned by this mount.
  useLayoutEffect(() => closePickers, [closePickers])
  useEffect(() => {
    if (choosing && !web) Keyboard.dismiss()
  }, [choosing, web])
  const angle = useRef(new Animated.Value(0)).current
  const reduced = useMotionPreference()
  useEffect(() => {
    const target = choosing ? 1 : 0
    if (reduced) {
      angle.setValue(target)
      return
    }
    const animation = Animated.timing(angle, {
      toValue: target,
      duration: 150,
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [choosing, angle, reduced])
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  useLayoutEffect(() => {
    if (web) sizeComposerText(input.current)
  }, [web, text])
  useEffect(() => {
    if (web) return watchComposerWidth(input.current)
  }, [web])
  const toggleRef = useRef<React.ComponentRef<typeof View>>(null)
  const panelRef = useRef<React.ComponentRef<typeof View>>(null)
  const focusingField = useRef(false)
  const resumeKeyboard = props.returnToKeyboard
  const returnToField = useCallback(() => {
    resumeKeyboard?.()
    closePickers()
    const field = input.current
    if (Platform.OS === 'android' && field?.isFocused() === true) field.blur()
    focusingField.current = true
    try {
      field?.focus()
    } finally {
      focusingField.current = false
    }
  }, [closePickers, resumeKeyboard])
  // The shell owns predictive Back on Android. An open drawer takes the
  // scene's back action as well as ordinary hardware Back.
  useBackOverride(!web && choosing && props.asleep !== true, returnToField)
  useEffect(() => {
    if (!choosing) return
    if (Platform.OS === 'android') {
      const back = BackHandler.addEventListener('hardwareBackPress', () => {
        returnToField()
        return true
      })
      return () => {
        back.remove()
      }
    }
    if (web)
      return bindAttachmentMenu(
        panelRef.current,
        toggleRef.current,
        returnToField,
        closePickers
      )
  }, [choosing, closePickers, returnToField, web])
  const selection = useRef<ComposerSelection>({
    start: text.length,
    end: text.length
  })
  const editKey = useRef<string | undefined>(undefined)
  const pendingCaret = useRef<ComposerSelection | undefined>(undefined)
  const [caretRevision, setCaretRevision] = useState(0)
  const latest = useRef(props)
  latest.current = props
  const canSend = sendAllowed({
    enabled,
    sending,
    preparing: props.preparing === true,
    text,
    attachments,
    editingCaption: context?.kind === 'edit' && context.hasAttachments === true
  })
  const showSend =
    text.trim() !== '' ||
    attachments.length > 0 ||
    (context?.kind === 'edit' && context.hasAttachments === true)
  const acceptsShortcut =
    takes &&
    props.preparing !== true &&
    props.shortcutsActive === true &&
    !emoji &&
    !choosing
  const shortcut =
    acceptsShortcut && context?.kind === 'edit' && context.saving !== true
      ? 'Escape'
      : acceptsShortcut &&
          !sending &&
          context == null &&
          text === '' &&
          attachments.length === 0 &&
          props.onEditLatest != null
        ? 'ArrowUp'
        : undefined
  const hardware = useRef<(key: string) => boolean>(() => false)
  hardware.current = key => {
    if (key !== shortcut) return false
    if (key === 'Escape') props.onCancelContext()
    else props.onEditLatest?.()
    return true
  }
  useEffect(
    () =>
      registerFocus?.(caret => {
        if (!latest.current.enabled || latest.current.asleep === true) return
        closePickers()
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
    [registerFocus, closePickers]
  )
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret == null || !takes) return
    pendingCaret.current = undefined
    selection.current = caret
    setComposerSelection(input.current, caret)
  }, [text, takes, caretRevision])
  useEffect(
    () =>
      bindComposerKeys(
        input.current,
        () => {
          const current = latest.current
          if (
            sendAllowed({
              enabled: current.enabled && current.asleep !== true,
              sending: current.sending,
              preparing: current.preparing === true,
              text: current.text,
              attachments: current.attachments,
              editingCaption:
                current.context?.kind === 'edit' &&
                current.context.hasAttachments === true
            })
          )
            current.onSend()
        },
        key => hardware.current(key),
        () => latest.current.onInterruptShortcut?.()
      ),
    []
  )

  const attach = (source: PickSource): void => {
    const current = latest.current
    if (
      !current.enabled ||
      current.asleep === true ||
      current.sending ||
      current.preparing === true ||
      current.context?.kind === 'edit'
    )
      return
    closePickers()
    onAttach(source)
  }

  const sourceLabels = {
    photos: lstrings.chat_photo_library,
    camera: lstrings.chat_camera,
    files: lstrings.chat_file
  }
  const sourceIcons = {
    photos: 'photoLibrary',
    camera: 'camera',
    files: 'description'
  } as const
  const compactSources =
    !web && (props.attachmentPanelHeight ?? 260) < theme.rem(6)
  const showSources =
    canAttach && (choosing || (!web && props.returningToKeyboard === true))
  const sourceButtons =
    showSources &&
    props.sources.map(source => (
      <Pressable
        key={source}
        accessibilityRole="button"
        accessibilityLabel={sourceLabels[source]}
        onPress={() => {
          attach(source)
        }}
        style={({ pressed }) => [
          web ? styles.menuItem : styles.source,
          compactSources && styles.compactSource,
          pressed && styles.pressed
        ]}
      >
        <View
          style={[
            !web && styles.sourceIcon,
            compactSources && styles.compactSourceIcon
          ]}
        >
          <ButtonIcon
            name={sourceIcons[source]}
            color={theme.primaryTextColor}
          />
        </View>
        <Text style={styles.sourceText}>{sourceLabels[source]}</Text>
      </Pressable>
    ))
  const panel = showSources && (
    <View
      ref={panelRef}
      testID={choosing ? 'chat-attachment-panel' : undefined}
      pointerEvents={choosing ? 'auto' : 'none'}
      accessibilityElementsHidden={!choosing}
      importantForAccessibility={choosing ? 'auto' : 'no-hide-descendants'}
      style={
        web
          ? styles.webMenu
          : [styles.sources, { height: props.attachmentPanelHeight ?? 260 }]
      }
    >
      {web ? (
        <View style={styles.menuRows}>{sourceButtons}</View>
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="always"
          contentContainerStyle={[
            styles.sourceRow,
            compactSources && styles.compactSourceRow
          ]}
        >
          {sourceButtons}
        </ScrollView>
      )}
    </View>
  )

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
            disabled={context.kind === 'edit' && context.saving === true}
            onPress={props.onCancelContext}
            style={styles.chipClose}
          >
            <ButtonIcon
              name="close"
              size={1}
              color={theme.secondaryTextColor}
            />
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
              {file.contentType.startsWith('image/') ? (
                <DraftPhoto file={file} files={props.files ?? platformFiles} />
              ) : (
                <Icon
                  name="attach_file"
                  size={0.875}
                  color={theme.secondaryTextColor}
                />
              )}
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
                <ButtonIcon
                  name="close"
                  size={0.875}
                  color={theme.secondaryTextColor}
                />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <ChatComposerRow style={styles.row} collapsable={false}>
        {web && panel}
        {props.sources.length > 0 && (
          <Pressable
            accessibilityRole="button"
            ref={toggleRef}
            testID="chat-attachment-toggle"
            accessibilityLabel={
              choosing ? lstrings.chat_close_attachments : lstrings.chat_attach
            }
            accessibilityState={{ disabled: !canAttach, expanded: choosing }}
            disabled={!canAttach}
            onPress={() => {
              if (choosing) returnToField()
              else {
                if (!web) props.onOpenAttachments?.()
                setPicker('attachments')
              }
            }}
            style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
          >
            <Animated.View
              style={{
                transform: [
                  {
                    rotate: angle.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '45deg']
                    })
                  }
                ]
              }}
            >
              <ButtonIcon
                name="add"
                color={
                  canAttach ? theme.primaryTextColor : theme.tertiaryTextColor
                }
              />
            </Animated.View>
          </Pressable>
        )}
        <View
          testID="chat-composer-field"
          style={[styles.field, !enabled && styles.inputOff]}
        >
          {Platform.OS === 'ios' && (
            // UITextView can change its intrinsic height on blur. Measure the
            // draft at the same width so the field and buttons keep their size
            // when the keyboard gives way to the attachment panel.
            <Text
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.input, styles.measureText]}
            >
              {text + '\u200b'}
            </Text>
          )}
          <TextInput
            ref={input}
            onPressIn={() => {
              if (choosing) returnToField()
            }}
            onFocus={() => {
              if (choosing && !focusingField.current) {
                resumeKeyboard?.()
                closePickers()
              }
              props.onRead?.()
            }}
            onBlur={props.onInterruptShortcut}
            nativeID={
              shortcut === 'ArrowUp'
                ? 'chatComposerEditLatest'
                : shortcut === 'Escape'
                  ? 'chatComposerCancelEdit'
                  : 'chatComposerField'
            }
            testID="chat-composer"
            accessibilityLabel={lstrings.chat_composer}
            value={text}
            onSelectionChange={event => {
              selection.current = event.nativeEvent.selection
            }}
            onKeyPress={event => {
              const key = event.nativeEvent.key
              if (
                'chatHardwareKey' in event.nativeEvent &&
                event.nativeEvent.chatHardwareKey === true &&
                hardware.current(key)
              )
                return
              if (key !== 'ArrowUp') latest.current.onInterruptShortcut?.()
              // A native hardware press can interrupt an older-page lookup while
              // the text system continues to handle the actual key normally.
              if (key !== 'Unidentified') editKey.current = key
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
            editable={takes}
            multiline
            {...(web ? { numberOfLines: 1 } : {})}
            placeholder={
              enabled ? lstrings.chat_composer : lstrings.chat_composer_locked
            }
            placeholderTextColor={theme.placeholderTextColor}
            style={[
              styles.input,
              Platform.OS === 'ios' && StyleSheet.absoluteFill,
              Platform.OS === 'ios' && styles.iosTextInsets,
              // iOS keeps a multiline field at its old height when a send
              // clears the draft from outside; an empty field is one line.
              Platform.OS === 'ios' && text === '' && styles.inputEmpty
            ]}
          />
          {web && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.chat_emoji}
              accessibilityState={{ disabled: !enabled, expanded: emoji }}
              disabled={!enabled}
              onPress={() => {
                setPicker(emoji ? undefined : 'emoji')
              }}
              style={({ pressed }) => [styles.emoji, pressed && styles.pressed]}
            >
              <ButtonIcon
                name="mood"
                color={
                  enabled ? theme.primaryTextColor : theme.tertiaryTextColor
                }
              />
            </Pressable>
          )}
        </View>
        {showSend && (
          <Pressable
            accessibilityRole="button"
            testID="chat-send"
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
            <ButtonIcon
              name="send"
              color={canSend ? theme.buttonTextColor : theme.tertiaryTextColor}
            />
          </Pressable>
        )}
      </ChatComposerRow>
      {!web && panel}
      {emoji && (
        <EmojiPicker
          onPick={picked => {
            onText(text + picked, {
              selection: { start: text.length, end: text.length }
            })
          }}
          onClose={() => {
            closePickers()
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  composer: {
    gap: theme.rem(theme.spaceXsRem),
    paddingVertical: theme.rem(theme.spaceXsRem)
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
    borderRadius: theme.radiusPill,
    backgroundColor: theme.pillBackground
  },
  emoji: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
    borderRadius: theme.radiusPill
  },
  field: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    borderRadius: theme.rem(1.375),
    backgroundColor: theme.inputBackgroundColor
  },
  pressed: {
    opacity: 0.6
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: theme.rem(2.75) - 2,
    maxHeight: theme.rem(8) - 2,
    lineHeight: theme.rem(1.25),
    textAlignVertical: 'center',
    includeFontPadding: false,
    backgroundColor: 'transparent',
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    paddingHorizontal: theme.rem(0.875),
    paddingVertical: theme.rem(0.75) - 1
  },
  measureText: { opacity: 0 },
  // UITextView measures a taller first line than the browser textarea.
  // Leave that line and both borders within the adjacent 2.75rem control.
  iosTextInsets: {
    paddingVertical: theme.rem(0.625) - 1
  },
  inputEmpty: {
    height: theme.rem(2.75) - 2
  },
  inputOff: {
    backgroundColor: theme.inactiveBackgroundColor
  },
  send: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radiusPill,
    backgroundColor: theme.primaryButtonColor
  },
  sendOff: {
    backgroundColor: theme.inactiveBackgroundColor
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.radiusPill,
    paddingHorizontal: theme.rem(1.25),
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
  draftPhoto: {
    width: theme.rem(3),
    height: theme.rem(3),
    borderRadius: theme.rem(0.5)
  },
  webMenu: {
    position: 'absolute',
    // Attach is bottom-aligned in the row even when the text field grows.
    bottom: theme.rem(2.75),
    left: 0,
    marginBottom: theme.rem(0.375),
    width: theme.rem(11),
    maxWidth: '100%',
    zIndex: 1,
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    borderRadius: theme.rem(0.875),
    backgroundColor: theme.cardBackgroundColor
  },
  menuRows: { padding: theme.rem(0.25) },
  menuItem: {
    flexDirection: 'row',
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    gap: theme.rem(0.75),
    paddingHorizontal: theme.rem(0.75)
  },
  sources: {
    overflow: 'hidden',
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.rem(1.5)
  },
  sourceRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: theme.rem(1.25),
    paddingHorizontal: theme.rem(1),
    gap: theme.rem(1)
  },
  compactSourceRow: {
    paddingTop: 0,
    paddingHorizontal: theme.rem(0.5)
  },
  compactSource: {
    minHeight: theme.rem(2.75),
    justifyContent: 'center',
    gap: 0
  },
  compactSourceIcon: {
    width: theme.rem(1.5),
    height: theme.rem(1.5)
  },
  source: {
    alignItems: 'center',
    minWidth: theme.rem(3),
    flexShrink: 1,
    gap: theme.rem(0.4)
  },
  sourceIcon: {
    width: theme.rem(3),
    height: theme.rem(3),
    borderRadius: theme.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.isDark
      ? theme.pillBackground
      : theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.inputBorderColor
  },
  sourceText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    textAlign: 'center',
    color: theme.primaryTextColor
  }
}))
