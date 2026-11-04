import React, {
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useMemo,
  useRef
} from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { changeBatches } from './changeTable'
import { Composer, type ComposerHandle } from './Composer'
import { QueuedMessages } from './QueuedMessages'
import { TessLiveReply, TessMessage } from './TessMessage'
import { useTessOverlay } from './TessOverlay'
import type { TessChatState } from './useTess'
import type { LevelSource } from './useTessMicrophone'

export interface TessChatProps {
  tess: TessChatState
  onClose: () => void
  /** An app path from a link or a way bubble. */
  onNavigate: (path: string) => void
  /** The microphone, right of Send. */
  mic?: ReactNode
  /** While the microphone records, its loudness, for the field's waveform. */
  dictating?: LevelSource
  /** Why the microphone heard nothing, under the field when Tess has no error. */
  micMessage?: string | null
  /** Where the microphone's words go into the composer. */
  composer?: Ref<ComposerHandle>
  /** Asked once on opening: whether her field should take the focus. */
  takesFocus?: () => boolean
}

/**
 * The chat with Tess: a title bar, her icon and "Ask Tess" on the left and
 * the close X on the right, the conversation, which follows its newest
 * message, and the composer. While she answers, the reply she is working on
 * shows under the last message as it comes, or "Tess is thinking…" until
 * she has told anything of it. The changes her replies to one message
 * propose show together under the last of them, held once (`changeBatches`).
 * Messages sent while she answers wait between the conversation and the
 * composer (`QueuedMessages`), and one pressed to edit goes into the field.
 */
export function TessChat({
  tess,
  onClose,
  onNavigate,
  mic,
  dictating,
  micMessage,
  composer,
  takesFocus
}: TessChatProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const overlay = useTessOverlay()
  const { send, upload, stop, showError } = tess
  // The composer's handle, which the queue edits through, shared with the
  // microphone's.
  const field = useRef<ComposerHandle>(null)
  useImperativeHandle(composer, () => ({
    insertDictation: text => {
      field.current?.insertDictation(text)
    },
    edit: draft => {
      field.current?.edit(draft)
    },
    draft: () => field.current?.draft() ?? { text: '', attachments: [] }
  }))
  // A table or chart open over the pane would hide the page a link goes to,
  // so the link closes it first.
  const navigate = (path: string): void => {
    overlay?.dismiss()
    onNavigate(path)
  }
  const confirmAll = (changeIds: string[]): void => {
    tess.confirmAll(changeIds).catch(() => undefined)
  }
  const batches = useMemo(() => changeBatches(tess.messages), [tess.messages])
  return (
    <KeyboardAvoidingView
      testID="Tess chat"
      // Android draws the app edge to edge, and its window does not shrink
      // for the keyboard, so the chat shrinks itself (`height`), as
      // `PickerDialog` does; iOS pads by the keyboard's height.
      behavior={
        Platform.OS === 'ios'
          ? 'padding'
          : Platform.OS === 'android'
            ? 'height'
            : undefined
      }
      style={[
        styles.chat,
        { paddingTop: insets.top, paddingBottom: insets.bottom }
      ]}
    >
      <View style={styles.titleBar}>
        <View style={styles.heading}>
          <Icon name="auto_awesome" size={1.5} />
          <Text accessibilityRole="header" style={styles.title}>
            {lstrings.tess_heading}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.tess_close}
          onPress={onClose}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        >
          <Icon name="close" size={1.5} />
        </Pressable>
      </View>
      <ScrollView
        ref={scroll}
        style={styles.list}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          scroll.current?.scrollToEnd({ animated: true })
        }}
      >
        {tess.loading ? (
          <ActivityIndicator />
        ) : (
          tess.messages.length === 0 &&
          !tess.thinking && (
            <Text style={styles.empty}>{lstrings.tess_empty}</Text>
          )
        )}
        {tess.messages.map(message => (
          <TessMessage
            key={message.id}
            message={message}
            changes={batches.get(message.id)}
            onNavigate={navigate}
            onConfirmAll={confirmAll}
            holdDisabled={tess.thinking}
            thoughtSeconds={tess.thoughtSeconds[message.id]}
          />
        ))}
        {tess.thinking &&
          (tess.live != null &&
          (tess.live.thinking !== '' ||
            tess.live.steps.length > 0 ||
            tess.live.text !== '') ? (
            <View testID="Tess thinking">
              <TessLiveReply live={tess.live} onNavigate={navigate} />
            </View>
          ) : (
            <View testID="Tess thinking" style={styles.thinking}>
              <ActivityIndicator size="small" />
              <Text style={styles.thinkingText}>{lstrings.tess_thinking}</Text>
            </View>
          ))}
      </ScrollView>
      <QueuedMessages
        queued={tess.queued}
        onSendNow={id => {
          tess.sendNow(id).catch(() => undefined)
        }}
        onRemove={id => {
          tess.unqueue(id)
        }}
        onEdit={id => {
          // The one out for editing, if any, goes back as the field has it.
          const draft = tess.editQueued(id, field.current?.draft())
          if (draft != null) field.current?.edit(draft)
        }}
      />
      <Composer
        handle={field}
        takesFocus={takesFocus}
        busy={tess.thinking}
        error={
          tess.error != null && tess.error !== '' ? tess.error : micMessage
        }
        mic={mic}
        dictating={dictating}
        onSend={send}
        onStop={() => {
          stop().catch(() => undefined)
        }}
        onUpload={upload}
        onError={showError}
      />
    </KeyboardAvoidingView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  chat: { flex: 1, backgroundColor: theme.backgroundColor },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: theme.rem(3.5),
    paddingLeft: theme.rem(theme.spaceLgRem),
    paddingRight: theme.rem(theme.spaceSmRem),
    borderBottomWidth: 1,
    borderBottomColor: theme.defaultBorderColor
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  close: {
    width: theme.rem(3),
    height: theme.rem(3),
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { opacity: 0.6 },
  list: { flex: 1 },
  messages: {
    gap: theme.rem(theme.spaceMdRem),
    padding: theme.rem(theme.spaceMdRem)
  },
  empty: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor,
    textAlign: 'center',
    marginTop: theme.rem(theme.spaceXlRem)
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  thinkingText: {
    fontFamily: theme.regularTextFont,
    fontStyle: 'italic',
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
