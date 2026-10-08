import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { DefensiveFieldArt } from './DefensiveFieldArt'
import { RosterDrag, RosterScrollArea } from './RosterDrag'
import { type Position, POSITIONS } from './scoringTypes'

/** Position centres as percentages of the top-down field. */
export const DEFENSE_LOCATIONS: Record<Position, readonly [number, number]> = {
  LF: [17, 15],
  CF: [50, 8],
  RF: [83, 15],
  SS: [33, 39],
  '2B': [67, 39],
  '3B': [17, 61],
  P: [50, 60],
  '1B': [83, 61],
  C: [50, 86]
}

/** All targets remain registered while the player roster scrolls below. */
export function DefensiveField({
  defense,
  compact = false,
  display,
  onPlace,
  onClear
}: {
  defense: Partial<Record<Position, number | null>>
  compact?: boolean
  display: (id: number) => string
  onPlace: (id: number, position: Position) => void
  onClear: (position: Position) => void
}): React.ReactElement {
  const [viewportHeight, setViewportHeight] = useState(0)
  const scroll = compact || (viewportHeight > 0 && viewportHeight < 240)
  const field = (
    <View
      testID="Defensive field"
      style={{
        flex: scroll ? undefined : 1,
        height: scroll ? 240 : undefined,
        minHeight: 0,
        backgroundColor: '#eeeeee',
        borderRadius: 8
      }}
    >
      <DefensiveFieldArt />
      {POSITIONS.map(position => {
        const id = defense[position]
        const [x, y] = DEFENSE_LOCATIONS[position]
        return (
          <View
            key={position}
            style={{
              position: 'absolute',
              width: '30%',
              left: `${x - 15}%`,
              top: `${y - 7}%`
            }}
          >
            <RosterDrag
              targetId={`defense-${position}`}
              value={id == null ? undefined : display(id)}
              label={id == null ? `Assign ${position}` : `Clear ${position}`}
              onTap={
                id == null
                  ? undefined
                  : () => {
                      onClear(position)
                    }
              }
              onDropPlayer={player => {
                onPlace(player, position)
              }}
            >
              <View
                style={{
                  minHeight: 36,
                  paddingHorizontal: 3,
                  paddingVertical: 3,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: '#555',
                  borderRadius: 5,
                  backgroundColor: id == null ? '#ffffffbb' : '#fff',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Text
                  style={{ color: '#222', fontSize: 11, fontWeight: '700' }}
                >
                  {position}
                </Text>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.75}
                  style={{
                    color: '#222',
                    fontSize: 11,
                    width: '100%',
                    textAlign: 'center'
                  }}
                >
                  {id == null ? 'Unassigned' : display(id)}
                </Text>
              </View>
            </RosterDrag>
          </View>
        )
      })}
    </View>
  )
  return (
    <View
      testID="Defensive field viewport"
      style={{ flex: 1, minHeight: 0 }}
      onLayout={event => {
        setViewportHeight(event.nativeEvent.layout.height)
      }}
    >
      {scroll ? (
        <RosterScrollArea name="Defensive positions">{field}</RosterScrollArea>
      ) : (
        field
      )}
    </View>
  )
}
