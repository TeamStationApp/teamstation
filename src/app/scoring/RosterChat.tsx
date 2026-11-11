import React, { type ReactNode, useRef } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { MESSAGE_COLOR, SAID_COLOR } from './dictationControls'

/** One thing said on the roster screen, and what came of it. */
export interface ChatTurn {
  key: number
  /** The words, as they are heard and then as transcribed; absent for a note. */
  said?: string
  /** What was done, or why nothing was. */
  lines: Array<{ kind: 'done' | 'problem'; text: string }>
}

/** Three lines, so the tabs and the lists keep most of the screen. */
const CHAT_HEIGHT = 66

/**
 * The roster screen's dictation, as a conversation in the yellow outline of
 * the scoring log: each turn's words on the right in white, what they did on
 * the left in the log's yellow, and a refusal in the log's message colour.
 * Every turn stays while the screen is open, and the newest is scrolled to.
 * A question, the model's or the screen's own about which player was meant,
 * is drawn under the turns, below the one it is about, whatever their
 * scroll. Nothing is drawn before the first dictation.
 *
 * It floats over the screen, with a shadow. Its X, or a tap anywhere in it
 * but on the question's buttons, closes it; a drag scrolls its turns. The
 * tap surface is no accessibility element, so a screen reader reaches the
 * turns, the question's buttons and the X each on its own, and closes with
 * the X.
 */
export function RosterChat({
  turns,
  ask,
  onClose
}: {
  turns: readonly ChatTurn[]
  ask?: ReactNode
  onClose?: () => void
}): React.ReactElement | null {
  const theme = useTheme()
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  if (turns.length === 0 && ask == null) return null
  return (
    <Pressable
      testID="Roster chat"
      accessible={false}
      tabIndex={-1}
      accessibilityLabel={lstrings.dictation_chat}
      accessibilityLiveRegion="polite"
      onPress={onClose}
      style={{
        flexShrink: 1,
        minHeight: 0,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        overflow: 'hidden',
        shadowColor: '#000000',
        shadowOpacity: 0.5,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6
      }}
    >
      <ScrollView
        ref={scroll}
        style={{ flexGrow: 0, maxHeight: CHAT_HEIGHT }}
        contentContainerStyle={{
          paddingHorizontal: 8,
          // Clear of the X.
          paddingRight: onClose == null ? 8 : 32,
          paddingVertical: 4,
          gap: 2
        }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          scroll.current?.scrollToEnd({ animated: false })
        }}
      >
        {turns.map(turn => (
          <View key={turn.key} style={{ gap: 2 }}>
            {turn.said != null && (
              <Text
                testID="Roster chat said"
                style={{
                  textAlign: 'right',
                  color: SAID_COLOR,
                  fontFamily: theme.regularTextFont,
                  fontStyle: 'italic',
                  fontSize: 14,
                  lineHeight: 18
                }}
              >
                {turn.said}
              </Text>
            )}
            {turn.lines.map((line, index) => (
              <Text
                key={index}
                testID={
                  line.kind === 'done'
                    ? 'Roster chat line'
                    : 'Roster chat problem'
                }
                style={{
                  textAlign: 'left',
                  color:
                    line.kind === 'done'
                      ? theme.scoringCountdownColor
                      : MESSAGE_COLOR,
                  fontFamily: theme.semiBoldTextFont,
                  fontSize: 14,
                  lineHeight: 18
                }}
              >
                {line.text}
              </Text>
            ))}
          </View>
        ))}
      </ScrollView>
      {ask != null && (
        <View style={{ alignItems: 'flex-end', padding: 6 }}>{ask}</View>
      )}
      {onClose != null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.dictation_chat_close}
          hitSlop={8}
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 2,
            right: 4,
            width: 24,
            height: 24,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Icon name="close" size={1.125} color={SAID_COLOR} />
        </Pressable>
      )}
    </Pressable>
  )
}
