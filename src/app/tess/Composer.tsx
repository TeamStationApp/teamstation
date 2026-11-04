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
  type TextInputSelectionChangeEvent,
  View
} from 'react-native'

import { TESS_MAX_ATTACHMENTS } from '../../common/api'
import { isFinePointer } from '../chat/chatWebInteractions'
import { Icon } from '../components/Icon'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AttachPicker } from './AttachPicker'
import { AttachmentChip } from './TessMessage'
import type { TessAttachmentRef, TessUpload } from './tessTypes'
import { attachFailure } from './tessUploads'
import { TessWaveform } from './TessWaveform'
import type { LevelSource } from './useTessMicrophone'

/** What the chat can do to the composer from outside it. */
export interface ComposerHandle {
  /**
   * Words said at the microphone, put in the field at the cursor, in place
   * of what is selected, a space apart from the words either side; the
   * cursor goes after them. Nothing is sent.
   */
  insertDictation: (text: string) => void
  /**
   * A queued message to edit: its words and files replace the draft, which
   * is discarded, and the next send puts it back at its place (`seq`).
   */
  edit: (draft: QueuedDraft) => void
  /**
   * The draft as it is now, words and files: what a queued message out to
   * be edited has become, for it to go back to the queue as that.
   */
  draft: () => { text: string; attachments: TessAttachmentRef[] }
}

/** A queued message taken out to be edited. */
export interface QueuedDraft {
  text: string
  attachments: TessAttachmentRef[]
  seq: number
}

export interface ComposerProps {
  /**
   * Answers whether it was sent or queued; a failed send gives the draft
   * back. `seq` is the place of a queued message being edited.
   */
  onSend: (
    text: string,
    attachments: TessAttachmentRef[],
    options?: { seq?: number }
  ) => Promise<boolean>
  onUpload: (upload: TessUpload) => Promise<TessAttachmentRef | null>
  onError: (message: string) => void
  /** Stops Tess's turn: Stop, shown while she answers and the draft is empty. */
  onStop?: () => void
  /** Tess is still answering the last message. */
  busy: boolean
  error?: string | null
  /** The microphone, right of Send. */
  mic?: ReactNode
  /**
   * While the microphone records: its loudness, drawn as a waveform on the
   * field's last line, an empty line added for it when the field has text.
   */
  dictating?: LevelSource
  /** Where the chat's microphone puts what was said. */
  handle?: Ref<ComposerHandle>
  /** Asked once on mounting: whether this opening should take the focus. */
  takesFocus?: () => boolean
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
 * How long after a send Stop, which takes Send's place as the draft empties,
 * ignores a press: the second of a double press on Send is not a stop.
 */
export const STOP_GUARD_MS = 600

/** Where the cursor is in the field: `start` to `end`, the same for a caret. */
interface Selection {
  start: number
  end: number
}

/** `selection` within a text of `length`. */
function within(selection: Selection, length: number): Selection {
  const start = Math.min(Math.max(0, selection.start), length)
  return { start, end: Math.min(Math.max(start, selection.end), length) }
}

/** What follows a word with no space before it: closing punctuation. */
const CLOSING = /^[\s.,;:!?…)\]}'"’”»]/

/**
 * `words` put into `text` in place of `selection`, a space before them when
 * they follow a word and after them when a word follows; and where the
 * cursor goes, after them.
 */
export function insertWords(
  text: string,
  selection: Selection,
  words: string
): { text: string; caret: number } {
  const { start, end } = within(selection, text.length)
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const trail = after !== '' && !CLOSING.test(after) ? ' ' : ''
  const caret = before.length + lead.length + words.length
  return { text: `${before}${lead}${words}${trail}${after}`, caret }
}

/**
 * What the person's draft becomes when the field, which showed it as `text`
 * and the waveform's line after it (`text` + a newline that is only shown),
 * is changed to `value`. The edit is found by what the two share at either
 * end. One before the line is the draft's; one after it moves into the
 * draft at its end, without the line's newline, the cursor after it; one
 * that takes the line away ends it (`lineGone`), the draft kept as the edit
 * left it.
 */
export function editAroundLine(
  text: string,
  value: string
): { text: string; lineGone: boolean; caret?: number } {
  const shown = `${text}\n`
  const most = Math.min(shown.length, value.length)
  let prefix = 0
  while (prefix < most && shown[prefix] === value[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < most - prefix &&
    shown[shown.length - 1 - suffix] === value[value.length - 1 - suffix]
  )
    suffix += 1
  const end = shown.length - suffix
  const inserted = value.slice(prefix, value.length - suffix)
  // Taken out with the line's newline: the line has gone.
  if (prefix <= text.length && end > text.length)
    return { text: text.slice(0, prefix) + inserted, lineGone: true }
  // Typed after the line: the draft's, at its end.
  if (prefix > text.length) {
    const moved = text + inserted
    return { text: moved, lineGone: false, caret: moved.length }
  }
  return { text: value.slice(0, -1), lineGone: false }
}

/**
 * The field's `nativeID` on a phone or a tablet: iOS's Shift+Return newline
 * (`ios/TeamStation/TSShiftReturn.m`) acts on the field that carries it and
 * no other.
 */
export const FIELD_NATIVE_ID = 'tessComposerField'

/**
 * Where the user writes to Tess: a small + on the left, the field, Send and
 * the microphone on the right, the attached files above and any error below.
 * The field keeps its width whatever the buttons show. While Tess answers and the draft is empty (no
 * words, no files, none uploading) Send is Stop, which stops her turn; a
 * letter typed makes it Send again, and what it sends then waits in the
 * queue until she is done. For `STOP_GUARD_MS` after a send Stop ignores a
 * press, so a double press on Send sends once and stops nothing. A queued
 * message tapped to edit replaces the draft, and sent goes back to its
 * place, though the field was emptied on the way. A message takes at most five
 * files: a sixth is refused with the reason, as soon as it is taken, and +
 * says so rather than open.
 *
 * The field is one line, and grows with what is in it up to six lines, then
 * scrolls. On the web Enter sends and Shift+Enter starts a new line; on a
 * phone or a tablet the return key sends, and on an iPad's hardware
 * keyboard Shift+Return starts a new line (`TSShiftReturn.m`, which puts it
 * in as a paste). Pasted lines keep their breaks.
 *
 * While the microphone records, its waveform runs over the right fifth of
 * the field's last line; a field with text shows an empty line after it for
 * that, which is only shown and never sent (`editAroundLine`): taken away,
 * it stays away until the next recording, and what is typed on it joins the
 * draft's end. What was said goes in at the
 * cursor, which is kept through the field's selection events.
 */
export function Composer({
  onSend,
  onUpload,
  onError,
  onStop,
  busy,
  error,
  mic,
  dictating,
  handle,
  takesFocus
}: ComposerProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<TessAttachmentRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [attaching, setAttaching] = useState(false)
  // The cursor as the field last reported it, and one the field is told to
  // take for the draw that moves it: a value set from here puts a browser's
  // caret at the end. Let go of at the field's next report, so a phone's
  // field does not hold the cursor there.
  const selection = useRef<Selection>({ start: 0, end: 0 })
  const [placed, setPlaced] = useState<Selection>()
  const recording = dictating != null
  // The line added while recording changes what the field holds: the
  // cursor stays where it was. The person can take the line away, which
  // ends it until the next recording.
  const [wasRecording, setWasRecording] = useState(recording)
  const [lineGone, setLineGone] = useState(false)
  if (wasRecording !== recording) {
    setWasRecording(recording)
    setLineGone(false)
    if (text !== '') setPlaced(within(selection.current, text.length))
  }
  const lined = recording && !lineGone && text !== ''
  const shown = lined ? `${text}\n` : text
  // The web's field is a textarea, which does not grow by itself: its
  // height follows what it holds, measured as that changes and as its width
  // does (the column is dragged, the window resized), which changes how the
  // text wraps. A phone's grows within its limits on its own.
  const field = useRef<React.ComponentRef<typeof TextInput>>(null)
  // She was opened from a menu that has gone, and a keyboard's focus would go
  // with it. Only with a pointer: a touchscreen's keyboard would cover the chat.
  const takeFocus = useRef(takesFocus)
  useEffect(() => {
    if (isFinePointer() && takeFocus.current?.() === true)
      field.current?.focus()
  }, [])
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
  }, [shown, width, styles.field])
  // The draft as it is now, for the microphone, which answers between
  // renders; a send empties it at once.
  const draft = useRef({ text, attachments, uploading })
  draft.current = { text, attachments, uploading }
  // The place of the queued message being edited, for its next send.
  const editing = useRef<number | undefined>(undefined)
  // When this composer last sent, for Stop to ignore a press soon after.
  const sentAt = useRef(-Infinity)

  const empty =
    text.trim() === '' && attachments.length === 0 && uploading === 0
  const ready =
    uploading === 0 && attachments.length <= TESS_MAX_ATTACHMENTS && !empty
  const stoppable = busy && empty && onStop != null
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
    sentAt.current = Date.now()
    // iOS keeps a grown field's height when only its value empties; the
    // native clear measures it again, back to one line.
    if (Platform.OS !== 'web') field.current?.clear()
    selection.current = { start: 0, end: 0 }
    setText('')
    setAttachments([])
    const seq = editing.current
    editing.current = undefined
    onSend(
      sent.text.trim(),
      sent.attachments,
      seq == null ? undefined : { seq }
    ).then(
      delivered => {
        if (delivered) return
        // Still the queued message's, unless another has been taken since.
        editing.current ??= seq
        // Ahead of anything said or typed since, which stays; the cursor at
        // the end, where the field shows it, for words said next.
        const current = draft.current.text
        const back =
          current === ''
            ? sent.text
            : sent.text === ''
              ? current
              : `${sent.text} ${current}`
        place(back, back.length)
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

  /** Puts `next` in the field, the cursor at `caret`. */
  const place = (next: string, caret: number): void => {
    const at = { start: caret, end: caret }
    selection.current = at
    draft.current = { ...draft.current, text: next }
    setText(next)
    setPlaced(at)
  }

  useImperativeHandle(handle, () => ({
    insertDictation: spoken => {
      const words = spoken.trim()
      if (words === '') return
      const inserted = insertWords(draft.current.text, selection.current, words)
      place(inserted.text, inserted.caret)
      // With a pointer the cursor shows where they went; a phone's keyboard
      // stays down.
      if (isFinePointer()) field.current?.focus()
    },
    edit: queued => {
      editing.current = queued.seq
      draft.current = { ...draft.current, attachments: queued.attachments }
      place(queued.text, queued.text.length)
      setAttachments(queued.attachments)
      field.current?.focus()
    },
    draft: () => ({
      text: draft.current.text,
      attachments: draft.current.attachments
    })
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
        <View style={styles.fieldBox}>
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
            value={shown}
            onChangeText={value => {
              if (!lined) {
                setText(value)
                return
              }
              // The line added for the waveform is not the draft's.
              const edited = editAroundLine(text, value)
              if (edited.lineGone) setLineGone(true)
              if (edited.caret == null) setText(edited.text)
              else place(edited.text, edited.caret)
            }}
            selection={placed}
            onSelectionChange={(event: TextInputSelectionChangeEvent) => {
              selection.current = event.nativeEvent.selection
              if (placed != null) setPlaced(undefined)
            }}
            onKeyPress={keyPress}
            style={[styles.field, grown != null && { height: grown }]}
          />
          {dictating != null && (
            <View style={styles.wave}>
              <TessWaveform
                levels={dictating}
                height={theme.rem(FIELD_LINE_REM)}
                color={theme.dangerColor}
              />
            </View>
          )}
        </View>
        {stoppable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.tess_stop}
            onPress={() => {
              if (Date.now() - sentAt.current >= STOP_GUARD_MS) onStop?.()
            }}
            style={({ pressed }) => [
              styles.round,
              styles.send,
              pressed && styles.pressed
            ]}
          >
            <Icon name="stop" size={1.25} color={theme.buttonTextColor} />
          </Pressable>
        ) : (
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
        )}
        {mic}
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
  fieldBox: { flex: 1 },
  // One line between its padding and borders, and at most six.
  field: {
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
  // The right fifth of the field's last line, clear of its rounded end.
  wave: {
    position: 'absolute',
    pointerEvents: 'none',
    left: '80%',
    right: theme.rem(0.75),
    bottom: theme.rem(FIELD_PADDING_REM) + 1,
    height: theme.rem(FIELD_LINE_REM)
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
