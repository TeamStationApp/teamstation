import React from 'react'
import { Text, View } from 'react-native'

import {
  UMPIRE_RANK_SYMBOLS,
  type UmpireLeaderboard
} from '../../common/umpireSchedule'
import { ListCard, ListRow, SectionHeader } from '../components'
import { useUmpireStyles } from './shared'
import { UmpireMaskDrawing } from './UmpireMaskDrawing'
// Coordinates are the top-left of each ten-point star in a trophy-sized tile.
const starPositions: Record<number, Array<[number, number]>> = {
  1: [[9, 9]],
  2: [
    [4, 9],
    [14, 9]
  ],
  3: [
    [9, 4],
    [4, 14],
    [14, 14]
  ],
  4: [
    [4, 4],
    [14, 4],
    [4, 14],
    [14, 14]
  ],
  5: [
    [2, 2],
    [16, 2],
    [9, 9],
    [2, 16],
    [16, 16]
  ]
}
export function UmpireLeaderboardView({
  board
}: {
  board: UmpireLeaderboard
}): React.ReactElement {
  const s = useUmpireStyles()
  const rank = (index: number, symbol: string): React.ReactNode =>
    index < 3 ? (
      <View
        accessibilityLabel={`${['Gold', 'Silver', 'Bronze'][index]} trophy`}
      >
        <UmpireMaskDrawing
          trophy
          size={28}
          color={['#B8860B', '#888888', '#AD6F36'][index]}
        />
      </View>
    ) : index < 8 ? (
      <View
        accessible
        accessibilityLabel={`${8 - index} ${index === 7 ? 'star' : 'stars'}`}
        style={{ width: 28, height: 28 }}
      >
        {starPositions[8 - index].map(([left, top], i) => (
          <Text
            key={i}
            accessible={false}
            allowFontScaling={false}
            aria-hidden
            style={{
              position: 'absolute',
              left,
              top,
              width: 10,
              height: 10,
              fontSize: 10,
              lineHeight: 10,
              includeFontPadding: false,
              textAlign: 'center',
              color: '#B8860B'
            }}
          >
            ★
          </Text>
        ))}
      </View>
    ) : (
      <Text style={s.text}>{symbol}</Text>
    )
  return (
    <View style={s.page}>
      {(['completed', 'scheduled'] as const).map(kind => (
        <View key={kind}>
          <SectionHeader
            title={
              kind === 'completed'
                ? 'Completed games'
                : 'Scheduled and completed games'
            }
          />
          <ListCard>
            {board[kind].map((p, index) => (
              <ListRow
                key={p.userId}
                title={p.name}
                trailing={String(p.count)}
                leading={rank(index, p.symbol)}
              />
            ))}
          </ListCard>
        </View>
      ))}
      {board.teams != null && (
        <View>
          <SectionHeader title="Team credits" />
          <ListCard>
            {board.teams.map((t, index) => (
              <ListRow
                key={t.id}
                title={t.name}
                trailing={String(t.count)}
                leading={rank(index, UMPIRE_RANK_SYMBOLS[index] ?? '')}
              />
            ))}
          </ListCard>
        </View>
      )}
    </View>
  )
}
