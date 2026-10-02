import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import {
  CONTROL_COLORS,
  ControlBackdrop,
  controlFrame,
  ControlIcon
} from '../scoring/ScoringControlAppearance'
import { useTheme } from '../theme/ThemeContext'

export interface WalkUpControlProps {
  batterName: string
  /** The batter's clip is playing: the button stops it. */
  playing: boolean
  /** The song is not on this phone. */
  dimmed: boolean
  /** Why a dimmed note does nothing, beside it, after a tap. */
  toast?: string | null
  onPress: () => void
}

/**
 * The scoring screen's walk-up button, directly above More and drawn with
 * the same frame, gradient and icon art as the other scoring controls.
 * The note stays a music note; the caption is SONG, or STOP while it plays.
 * Dimmed when the song is not on this phone, where a tap shows why beside it.
 */
export function WalkUpControl(props: WalkUpControlProps): React.ReactElement {
  const { batterName, playing, dimmed, toast, onPress } = props
  const theme = useTheme()
  const label = dimmed
    ? lstrings.walkup_note_not_here
    : playing
      ? lstrings.walkup_note_stop
      : lstrings.walkup_note_play
  return (
    <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0, zIndex: 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sprintf(label, batterName)}
        accessibilityState={{ disabled: dimmed }}
        testID="walk-up-note"
        onPress={onPress}
        style={{
          ...controlFrame,
          width: '100%',
          borderColor: CONTROL_COLORS.music.border,
          backgroundColor: CONTROL_COLORS.music.bottom,
          opacity: dimmed ? 0.4 : 1,
          overflow: 'hidden'
        }}
      >
        <ControlBackdrop kind="music" />
        <View
          pointerEvents="none"
          style={{ alignItems: 'center', justifyContent: 'center', gap: 1 }}
        >
          <ControlIcon kind="music" size={14} />
          <Text
            selectable={false}
            style={{
              color: CONTROL_COLORS.music.text,
              fontFamily: theme.regularTextFont,
              fontSize: 11,
              lineHeight: 13,
              fontWeight: '900',
              textAlign: 'center'
            }}
          >
            {playing
              ? lstrings.scoring_control_stop
              : lstrings.scoring_control_song}
          </Text>
        </View>
      </Pressable>
      {toast != null && (
        <View
          pointerEvents="none"
          testID="walk-up-toast"
          style={{
            position: 'absolute',
            left: '100%',
            marginLeft: 8,
            top: 0,
            width: 220,
            borderRadius: 12,
            paddingVertical: 8,
            paddingHorizontal: 12,
            backgroundColor: theme.primaryTextColor
          }}
        >
          <Text
            numberOfLines={2}
            style={{
              fontFamily: theme.regularTextFont,
              fontSize: theme.rem(0.875),
              color: theme.backgroundColor
            }}
          >
            {toast}
          </Text>
        </View>
      )}
    </View>
  )
}
