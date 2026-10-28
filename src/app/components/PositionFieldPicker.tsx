import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { PlayerPosition } from '../../common/playerSettings'
import { useTheme } from '../theme/ThemeContext'

/** The box the field is drawn in, and each toggle's diameter. */
export const FIELD_HEIGHT = 382
export const FIELD_MIN_WIDTH = 156
export const TOGGLE = 48

/**
 * Where each position stands: a fraction of the width the toggles can move
 * across, and a top offset. DH stands alone beneath the field. EH is a
 * game's alone and is not offered.
 */
export const FIELD_SPOTS: ReadonlyArray<{
  position: PlayerPosition
  x: number
  top: number
}> = [
  { position: 'LF', x: 0, top: 28 },
  { position: 'CF', x: 0.5, top: 0 },
  { position: 'RF', x: 1, top: 28 },
  { position: '3B', x: 0, top: 142 },
  { position: 'SS', x: 0.28, top: 94 },
  { position: '2B', x: 0.72, top: 94 },
  { position: '1B', x: 1, top: 142 },
  { position: 'P', x: 0.5, top: 166 },
  { position: 'C', x: 0.5, top: 254 },
  { position: 'DH', x: 0.5, top: 334 }
]

/** The positions a player plays, chosen where they stand on a field. */
export function PositionFieldPicker({
  positions,
  onToggle,
  disabled = false
}: {
  positions: readonly PlayerPosition[]
  onToggle: (position: PlayerPosition) => void
  disabled?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const [width, setWidth] = useState(FIELD_MIN_WIDTH)
  const free = Math.max(0, width - TOGGLE)
  return (
    <View
      testID="Position field"
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={{
        height: FIELD_HEIGHT,
        minWidth: FIELD_MIN_WIDTH,
        alignSelf: 'stretch'
      }}
    >
      {FIELD_SPOTS.map(({ position, x, top }) => {
        const on = positions.includes(position)
        return (
          <Pressable
            key={position}
            accessibilityRole="button"
            accessibilityLabel={`Player position ${position}`}
            accessibilityState={{ selected: on, disabled }}
            // react-native-web does not render `aria-selected` from
            // `accessibilityState` on a button, so the web says it directly.
            aria-selected={on}
            disabled={disabled}
            onPress={() => {
              onToggle(position)
            }}
            style={{
              position: 'absolute',
              left: free * x,
              top,
              width: TOGGLE,
              height: TOGGLE,
              borderRadius: TOGGLE / 2,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: theme.defaultBorderColor,
              backgroundColor: on
                ? theme.pillActiveBackground
                : theme.pillBackground,
              opacity: disabled ? 0.5 : 1
            }}
          >
            <Text
              style={{
                fontFamily: theme.semiBoldTextFont,
                fontSize: theme.rem(0.875),
                color: on ? theme.pillActiveTextColor : theme.pillTextColor
              }}
            >
              {position}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
