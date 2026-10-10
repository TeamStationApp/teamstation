import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { DefensiveFieldArt } from './DefensiveFieldArt'
import { RosterDrag } from './RosterDrag'
import { useScoringSheetTheme } from './scoringSheetTheme'
import { type Position, POSITIONS } from './scoringTypes'

/** Position centres as percentages of the top-down field. */
export const DEFENSE_LOCATIONS: Record<Position, readonly [number, number]> = {
  LF: [17, 15],
  CF: [50, 10],
  RF: [83, 15],
  SS: [33, 39],
  '2B': [67, 39],
  '3B': [17, 61],
  P: [50, 60],
  '1B': [83, 61],
  C: [50, 86]
}

/** Every position remains visible while only the roster scrolls. */
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
  const { scoringSurface: surface } = useScoringSheetTheme()
  const [viewportHeight, setViewportHeight] = useState(0)
  const singleLine = compact || (viewportHeight > 0 && viewportHeight < 180)
  const cardHeight =
    viewportHeight > 0 ? Math.max(12, Math.min(36, viewportHeight * 0.18)) : 36
  return (
    <View
      testID="Defensive field viewport"
      style={{ flexBasis: 240, flexGrow: 0, flexShrink: 1, minHeight: 60 }}
      onLayout={event => {
        setViewportHeight(event.nativeEvent.layout.height)
      }}
    >
      <View
        testID="Defensive field"
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: surface.canvas,
          borderRadius: 8
        }}
      >
        <DefensiveFieldArt />
        {POSITIONS.map(position => {
          const id = defense[position]
          const [x, y] = DEFENSE_LOCATIONS[position]
          const assigned = id != null
          const textColor = assigned
            ? surface.activeText
            : surface.badges.red.text
          return (
            <View
              key={position}
              style={{
                position: 'absolute',
                width: '30%',
                left: `${x - 15}%`,
                top: `${y - 9}%`
              }}
            >
              <RosterDrag
                targetId={`defense-${position}`}
                value={assigned ? display(id) : undefined}
                label={assigned ? `Clear ${position}` : `Assign ${position}`}
                onTap={
                  assigned
                    ? () => {
                        onClear(position)
                      }
                    : undefined
                }
                onDropPlayer={player => {
                  onPlace(player, position)
                }}
              >
                <View
                  testID={`Defense ${position} card`}
                  style={{
                    height: cardHeight,
                    paddingHorizontal: singleLine ? 1 : 3,
                    paddingVertical: singleLine ? 0 : 3,
                    borderWidth: 1,
                    borderStyle: assigned ? 'solid' : 'dashed',
                    borderColor: assigned
                      ? surface.accent
                      : surface.badges.red.border,
                    borderRadius: 5,
                    backgroundColor: assigned
                      ? surface.active
                      : surface.badges.red.background,
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  {singleLine ? (
                    <Text
                      numberOfLines={1}
                      style={{
                        color: textColor,
                        fontSize: 10,
                        lineHeight: 10,
                        width: '100%',
                        textAlign: 'center'
                      }}
                    >
                      {position} · {assigned ? display(id) : 'Unassigned'}
                    </Text>
                  ) : (
                    <>
                      <Text
                        style={{
                          color: textColor,
                          fontSize: 11,
                          fontWeight: '700'
                        }}
                      >
                        {position}
                      </Text>
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.91}
                        style={{
                          color: textColor,
                          fontSize: 11,
                          width: '100%',
                          textAlign: 'center'
                        }}
                      >
                        {assigned ? display(id) : 'Unassigned'}
                      </Text>
                    </>
                  )}
                </View>
              </RosterDrag>
            </View>
          )
        })}
      </View>
    </View>
  )
}
