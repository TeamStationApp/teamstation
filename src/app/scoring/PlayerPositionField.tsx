import React, { useState } from 'react'
import { View } from 'react-native'

import type { PlayerDraft } from './playerDraft'
import { ScoringPill } from './ScoringPill'

export const POSITION_BUTTON_SIZE = 48
export const PLAYER_POSITION_SPOTS = [
  { position: 'LF', x: 0, y: 28 },
  { position: 'CF', x: 0.5, y: 0 },
  { position: 'RF', x: 1, y: 28 },
  { position: '3B', x: 0, y: 142 },
  { position: 'SS', x: 0.28, y: 94 },
  { position: '2B', x: 0.72, y: 94 },
  { position: '1B', x: 1, y: 142 },
  { position: 'P', x: 0.5, y: 166 },
  { position: 'C', x: 0.5, y: 254 }
] as const

/** Fixed-size controls form a field within the form's right-hand column. */
export function PlayerPositionField({
  positions,
  onToggle
}: {
  positions: PlayerDraft['positions']
  onToggle: (position: string) => void
}): React.ReactElement {
  const [width, setWidth] = useState(156)
  const button = (position: string): React.ReactElement => (
    <ScoringPill
      label={position}
      accessibilityLabel={`Player position ${position}`}
      selected={positions.includes(position)}
      size={POSITION_BUTTON_SIZE}
      onPress={() => {
        onToggle(position)
      }}
    />
  )
  return (
    <View
      testID="Player position field"
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={{ height: 382, minWidth: 156 }}
    >
      {PLAYER_POSITION_SPOTS.map(spot => (
        <View
          key={spot.position}
          testID={`Position spot ${spot.position}`}
          style={{
            position: 'absolute',
            left: (width - POSITION_BUTTON_SIZE) * spot.x,
            top: spot.y
          }}
        >
          {button(spot.position)}
        </View>
      ))}
      <View
        testID="Extra hitter positions"
        style={{
          position: 'absolute',
          top: 334,
          alignSelf: 'center',
          flexDirection: 'row',
          gap: 12
        }}
      >
        {button('DH')}
        {button('EH')}
      </View>
    </View>
  )
}
