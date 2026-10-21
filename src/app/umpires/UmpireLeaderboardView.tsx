import React from 'react'
import { Text, View } from 'react-native'

import type { UmpireLeaderboard } from '../../common/umpireSchedule'
import { ListCard, ListRow, SectionHeader } from '../components'
import { useUmpireStyles } from './shared'
import { UmpireMaskDrawing } from './UmpireMaskDrawing'
export function UmpireLeaderboardView({
  board
}: {
  board: UmpireLeaderboard
}): React.ReactElement {
  const s = useUmpireStyles()
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
                end={
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
                  ) : (
                    <Text style={s.text}>{p.symbol}</Text>
                  )
                }
              />
            ))}
          </ListCard>
        </View>
      ))}
      {board.teams != null && (
        <View>
          <SectionHeader title="Team credits" />
          <ListCard>
            {board.teams.map(t => (
              <ListRow key={t.id} title={t.name} trailing={String(t.count)} />
            ))}
          </ListCard>
        </View>
      )}
    </View>
  )
}
