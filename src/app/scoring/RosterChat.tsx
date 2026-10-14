import React, { type ReactNode, useRef } from 'react'
import { ScrollView, Text, View } from 'react-native'

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
 */
export function RosterChat({
  turns,
  ask
}: {
  turns: readonly ChatTurn[]
  ask?: ReactNode
}): React.ReactElement | null {
  const theme = useTheme()
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  if (turns.length === 0 && ask == null) return null
  return (
    <View
      testID="Roster chat"
      accessibilityLabel={lstrings.dictation_chat}
      accessibilityLiveRegion="polite"
      style={{
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        overflow: 'hidden'
      }}
    >
      <ScrollView
        ref={scroll}
        style={{ flexGrow: 0, maxHeight: CHAT_HEIGHT }}
        contentContainerStyle={{
          paddingHorizontal: 8,
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
    </View>
  )
}
