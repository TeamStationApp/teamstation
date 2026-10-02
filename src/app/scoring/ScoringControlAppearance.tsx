import React from 'react'
import { Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ControlIcon } from './ScoringControlArt'
import { CONTROL_COLORS, type ControlKind } from './scoringControlStyle'
export { ControlBackdrop, ControlIcon } from './ScoringControlArt'
export {
  CONTROL_COLORS,
  CONTROL_DECK_HEIGHT,
  CONTROL_HEIGHT,
  CONTROL_GAP,
  controlFrame,
  DICTATION_LOG_HEIGHT
} from './scoringControlStyle'

export function ControlFace({
  kind,
  contact
}: {
  kind: Exclude<ControlKind, 'undo'>
  contact?: 'bunt' | 'swing'
}): React.ReactElement {
  const theme = useTheme()
  const label = {
    more: lstrings.scoring_control_more,
    ball: lstrings.scoring_control_ball,
    called: lstrings.scoring_control_called_strike,
    swing: lstrings.scoring_control_swing_miss,
    foul: lstrings.scoring_control_foul,
    contact:
      contact === 'bunt'
        ? lstrings.scoring_control_bunt
        : lstrings.scoring_control_swing,
    music: lstrings.scoring_control_song
  }[kind]
  // The face and its label span the button. A label that only hugs its
  // widest line wraps again on Android, where that width is rounded down:
  // "SWING\n& MISS" broke "& MISS" in two and lost MISS below the button.
  return (
    <View
      pointerEvents="none"
      style={{
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1
      }}
    >
      {kind === 'contact' ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            marginBottom: 2
          }}
        >
          <ControlIcon kind="contact" size={11} />
          <Text
            selectable={false}
            style={{
              color: '#fde68a',
              fontFamily: theme.regularTextFont,
              fontSize: 8,
              fontWeight: '700',
              letterSpacing: 1
            }}
          >
            {lstrings.scoring_in_play}
          </Text>
        </View>
      ) : (
        <ControlIcon kind={kind} size={kind === 'foul' ? 16 : 14} />
      )}
      <Text
        testID="scoring-control-label"
        selectable={false}
        numberOfLines={2}
        style={{
          alignSelf: 'stretch',
          color: CONTROL_COLORS[kind].text,
          fontFamily: theme.regularTextFont,
          fontSize: kind === 'contact' || kind === 'ball' ? 12 : 11,
          lineHeight: 13,
          fontWeight: '900',
          textAlign: 'center',
          letterSpacing: kind === 'contact' || kind === 'ball' ? 0.6 : 0
        }}
      >
        {label}
      </Text>
      {kind === 'ball' && (
        <Text
          selectable={false}
          style={{
            color: '#9cdbc1',
            fontFamily: theme.regularTextFont,
            fontSize: 8,
            lineHeight: 10,
            fontWeight: '600'
          }}
        >
          {lstrings.scoring_out_zone}
        </Text>
      )}
      {kind === 'contact' && (
        <View
          style={{
            width: 24,
            height: 2,
            marginTop: 2,
            borderRadius: 1,
            backgroundColor: '#542b1980'
          }}
        />
      )}
    </View>
  )
}
