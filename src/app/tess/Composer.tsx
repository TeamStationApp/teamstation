import React, {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  type TextInputKeyPressEvent,
  View
} from 'react-native'

import { TESS_MAX_ATTACHMENTS } from '../../common/api'
import { Icon } from '../components/Icon'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AttachPicker } from './AttachPicker'
import { AttachmentChip } from './TessMessage'
import type { TessAttachmentRef, TessUpload } from './tessTypes'
import { attachFailure } from './tessUploads'

/** What the chat can do to the composer from outside it. */
export interface ComposerHandle {
  /**
   * Words said at the microphone. They join the draft and go with its
   * attachments, as a press of Send would send them, or stay in the field
   * while Tess is still answering or a file is still uploading.
   */
  dictate: (text: string) => void
}

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
  /** Where the chat's microphone puts what was said. */
  handle?: Ref<ComposerHandle>
}

/** What the field is on the web: react-native-web's textarea. */
interface TextArea {
  style: { height: string }
  scrollHeight: number
}

/** The browser's `ResizeObserver`, as much of it as the field needs. */
type SizeWatcher = new (
  report: (entries: Array<{ contentRect: { width: number } }>) => void
) => { observe: (node: unknown) => void; disconnect: () => void }

/** The most lines the field grows to before it scrolls. */
export const FIELD_MAX_LINES = 6

/**
 * The field's `nativeID` on a phone or a tablet: iOS's Shift+Return newline
 * (`ios/TeamStation/TSShiftReturn.m`) acts on the field that carries it and
 * no other.
 */
export const FIELD_NATIVE_ID = 'tessComposerField'

/**
 * Where the user writes to Tess: a small + on the left, the field, send on
 * the right, the attached files above, any error below, and the microphone
 * centered under it all. A message takes at most five files: a sixth is
 * refused with the reason, as soon as it is taken, and + says so rather than
 * open.
 *
 * The field is one line, and grows with what is in it up to six lines, then
 * scrolls. On the web Enter sends and Shift+Enter starts a new line; on a
 * phone or a tablet the return key sends, and on an iPad's hardware
 * keyboard Shift+Return starts a new line (`TSShiftReturn.m`, which puts it
 * in as a paste). Pasted lines keep their breaks.
 */
export function Composer({
  onSend,
  onUpload,
  onError,
  busy,
  error,
  mic,
  handle
}: ComposerProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<TessAttachmentRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [attaching, setAttaching] = useState(false)
  // The web's field is a textarea, which does not grow by itself: its
  // height follows what it holds, measured as that changes and as its width
  // does (the column is dragged, the window resized), which changes how the
  // text wraps. A phone's grows within its limits on its own.
  const field = useRef<React.ComponentRef<typeof TextInput>>(null)
  const [grown, setGrown] = useState<number>()
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const node = field.current
    const Watcher = (globalThis as { ResizeObserver?: SizeWatcher })
      .ResizeObserver
    if (node == null || Watcher == null) return
    const observer = new Watcher(entries => {
      const [entry] = entries
      if (entry != null) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return
    const node = field.current as unknown as TextArea | null
    if (node == null) return
    const held = node.style.height
    node.style.height = '0px'
    // Its padding, its lines and its two borders.
    const content = node.scrollHeight + 2
    node.style.height = held
    setGrown(
      Math.min(
        styles.field.maxHeight,
        Math.max(styles.field.minHeight, content)
      )
    )
  }, [text, width, styles.field])
  // The draft as it is now, for the microphone, which answers between
  // renders; a send empties it at once.
  const draft = useRef({ text, attachments, busy, uploading })
  draft.current = { text, attachments, busy, uploading }

  const ready =
    !busy &&
    uploading === 0 &&
    attachments.length <= TESS_MAX_ATTACHMENTS &&
    (text.trim() !== '' || attachments.length > 0)
  const tooMany = (): void => {
    onError(
      sprintf(lstrings.tess_attach_too_many, String(TESS_MAX_ATTACHMENTS))
    )
  }

  /** Sends `sent`, emptying the draft, and gives it back if it fails. */
  const deliver = (sent: {
    text: string
    attachments: TessAttachmentRef[]
  }): void => {
    draft.current = { ...draft.current, text: '', attachments: [] }
    // iOS keeps a grown field's height when only its value empties; the
    // native clear measures it again, back to one line.
    if (Platform.OS !== 'web') field.current?.clear()
    setText('')
    setAttachments([])
    onSend(sent.text.trim(), sent.attachments).then(
      delivered => {
        if (delivered) return
        // Ahead of anything said or typed since, which stays.
        setText(current =>
          current === ''
            ? sent.text
            : sent.text === ''
              ? current
              : `${sent.text} ${current}`
        )
        setAttachments(current => {
          const back = [...sent.attachments, ...current]
          if (back.length > TESS_MAX_ATTACHMENTS) tooMany()
          return back
        })
      },
      () => undefined
    )
  }

  const send = (): void => {
    if (!ready) return
    deliver(draft.current)
  }

  useImperativeHandle(handle, () => ({
    dictate: spoken => {
      const words = spoken.trim()
      if (words === '') return
      const now = draft.current
      const typed = now.text.trim()
      const joined = typed === '' ? words : `${typed} ${words}`
      if (
        now.busy ||
        now.uploading > 0 ||
        now.attachments.length > TESS_MAX_ATTACHMENTS
      ) {
        draft.current = { ...now, text: joined }
        setText(joined)
        return
      }
      deliver({ text: joined, attachments: now.attachments })
    }
  }))

  /** Whether the draft holds, or is uploading, as many files as a message takes. */
  const full = (): boolean =>
    draft.current.attachments.length + draft.current.uploading >=
    TESS_MAX_ATTACHMENTS

  /**
   * A file taken: it counts as uploading from now, while it is still being
   * read, so Send waits for it, until it is uploaded or has failed. One more
   * than a message takes is refused, and not uploaded.
   */
  const attach = (pending: Promise<TessUpload | null>): void => {
    if (full()) {
      tooMany()
      pending.catch(() => undefined)
      return
    }
    draft.current = { ...draft.current, uploading: draft.current.uploading + 1 }
    setUploading(count => count + 1)
    pending
      .then(
        async upload => (upload == null ? null : await onUpload(upload)),
        (error: unknown) => {
          onError(attachFailure(error))
          return null
        }
      )
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
            if (!attaching && full()) {
              tooMany()
              return
            }
            setAttaching(open => !open)
          }}
          hitSlop={PLUS_SLOP}
          style={({ pressed }) => [styles.plus, pressed && styles.pressed]}
        >
          <Icon name="add" size={1.5} color={theme.secondaryTextColor} />
        </Pressable>
        <TextInput
          ref={field}
          testID="Tess field"
          nativeID={Platform.OS === 'web' ? undefined : FIELD_NATIVE_ID}
          accessibilityLabel={lstrings.tess_placeholder}
          placeholder={lstrings.tess_placeholder}
          placeholderTextColor={theme.placeholderTextColor}
          multiline
          // The web's textarea starts at one row. A phone's field takes rows
          // as its most lines (numberOfLines), so there it is left out and
          // the field grows to its maxHeight.
          rows={Platform.OS === 'web' ? 1 : undefined}
          // A phone's return key sends; the web's Enter is `keyPress`.
          returnKeyType="send"
          submitBehavior={Platform.OS === 'web' ? undefined : 'submit'}
          onSubmitEditing={Platform.OS === 'web' ? undefined : send}
          value={text}
          onChangeText={setText}
          onKeyPress={keyPress}
          style={[styles.field, grown != null && { height: grown }]}
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

// The + is 32 points; its touch target is 44.
const PLUS_SLOP = 6

const FIELD_LINE_REM = 1.375
const FIELD_PADDING_REM = 0.75

/** The field's height for this many lines: padding, lines and borders. */
function fieldHeight(theme: Theme, lines: number): number {
  return (
    theme.rem(FIELD_PADDING_REM) * 2 + theme.rem(FIELD_LINE_REM) * lines + 2
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
  // Borderless and unfilled, centred on a one-line field and on the last
  // line of a taller one.
  plus: {
    width: theme.rem(2),
    height: theme.rem(2),
    marginBottom: theme.rem(0.5),
    alignItems: 'center',
    justifyContent: 'center'
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
  // One line between its padding and borders, and at most six.
  field: {
    flex: 1,
    minHeight: fieldHeight(theme, 1),
    maxHeight: fieldHeight(theme, FIELD_MAX_LINES),
    paddingHorizontal: pillPadding(theme.rem(3)),
    paddingTop: theme.rem(FIELD_PADDING_REM),
    paddingBottom: theme.rem(FIELD_PADDING_REM),
    lineHeight: theme.rem(FIELD_LINE_REM),
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
