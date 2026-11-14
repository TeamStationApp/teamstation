import React from 'react'
import { Pressable, StyleSheet } from 'react-native'

import { ButtonIcon } from '../components/ButtonIcon'
import { lstrings } from '../locales/strings'

/** The volume button's face: white, with a black glyph, on or off. */
export const VOLUME_BUTTON_COLORS = {
  background: '#FFFFFF',
  glyph: '#000000',
  border: 'rgba(0,0,0,0.15)'
} as const

/**
 * The game's sound, on or off: one round white button with a black glyph, at
 * the upper left of the scoring screen and of the replay.
 */
export function VolumeButton(props: {
  on: boolean
  onToggle: () => void
  testID?: string
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.on ? lstrings.sound_mute : lstrings.sound_unmute
      }
      testID={props.testID}
      onPress={() => {
        props.onToggle()
      }}
      style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: VOLUME_BUTTON_COLORS.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: VOLUME_BUTTON_COLORS.border,
        // The floating buttons' soft drop shadow.
        shadowColor: '#000000',
        shadowOpacity: 0.4,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: 6
      }}
    >
      <ButtonIcon
        name={props.on ? 'volume_up' : 'volume_off'}
        size={1.5}
        color={VOLUME_BUTTON_COLORS.glyph}
      />
    </Pressable>
  )
}
