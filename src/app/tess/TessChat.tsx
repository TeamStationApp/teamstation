import React, { type ReactNode, useRef } from 'react'
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
import { Composer } from './Composer'
import { TessMessage } from './TessMessage'
import type { TessChatState } from './useTess'

export interface TessChatProps {
  tess: TessChatState
  onClose: () => void
  /** An app path from a link or a way bubble. */
  onNavigate: (path: string) => void
  /** The push-to-talk button, under the field. */
  mic?: ReactNode
}

/**
 * The chat with Tess: a title bar with the close X, the conversation, which
 * follows its newest message, and the composer.
 */
export function TessChat({
  tess,
  onClose,
  onNavigate,
  mic
}: TessChatProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const { send, upload, showError } = tess
  const confirm = (changeId: string): void => {
    tess.confirm(changeId).catch(() => undefined)
  }
  return (
    <KeyboardAvoidingView
      testID="Tess chat"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[
        styles.chat,
        { paddingTop: insets.top, paddingBottom: insets.bottom }
      ]}
    >
      <View style={styles.titleBar}>
        <Text accessibilityRole="header" style={styles.title}>
          {lstrings.tess_title}
        </Text>
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
            onNavigate={onNavigate}
            onConfirm={confirm}
          />
        ))}
        {tess.thinking && (
          <View testID="Tess thinking" style={styles.thinking}>
            <ActivityIndicator size="small" />
            <Text style={styles.thinkingText}>{lstrings.tess_thinking}</Text>
          </View>
        )}
      </ScrollView>
      <Composer
        busy={tess.thinking}
        error={tess.error}
        mic={mic}
        onSend={send}
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
