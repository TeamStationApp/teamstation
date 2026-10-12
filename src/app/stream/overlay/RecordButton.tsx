import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { lstrings } from '../../locales/strings'
import { RECORD, WHITE } from './overlayTheme'

export interface RecordButtonProps {
  recording: boolean
  disabled?: boolean
  onPress: () => void
}

/**
 * TS Cameraman's record button: a muted red disc with a pale dot while idle,
 * the bright record red with a white square while recording.
 */
export function RecordButton(props: RecordButtonProps): React.ReactElement {
  const { recording, disabled = false, onPress } = props
  return (
    <Pressable
      testID="broadcast-button"
      accessibilityRole="button"
      accessibilityLabel={
        recording ? lstrings.stream_record_stop : lstrings.stream_record_start
      }
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.disc,
        { backgroundColor: recording ? RECORD.live : RECORD.idle }
      ]}
    >
      <View style={recording ? styles.square : styles.dot} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  disc: {
    width: RECORD.size,
    height: RECORD.size,
    borderRadius: RECORD.size / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dot: {
    width: RECORD.idleDotSize,
    height: RECORD.idleDotSize,
    borderRadius: RECORD.idleDotSize / 2,
    backgroundColor: RECORD.idleDot
  },
  square: {
    width: RECORD.liveSquare,
    height: RECORD.liveSquare,
    borderRadius: RECORD.liveSquareRadius,
    backgroundColor: WHITE
  }
})
