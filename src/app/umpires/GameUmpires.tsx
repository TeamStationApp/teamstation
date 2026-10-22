import React from 'react'
import { View } from 'react-native'

import type { UmpireGameBlock } from '../../common/umpireSchedule'
import { Card, initialsOf, ListRow, SectionHeader } from '../components'
import { useTheme } from '../theme/ThemeContext'

export function GameUmpires({
  umpires
}: {
  umpires: UmpireGameBlock | null
}): React.ReactElement | null {
  const theme = useTheme()
  const people = new Map<
    string,
    {
      person: NonNullable<
        NonNullable<UmpireGameBlock>['positions'][number]['person']
      >
      types: Set<string>
    }
  >()
  for (const position of umpires?.positions ?? []) {
    if (position.person == null) continue
    const held = people.get(position.person.userId) ?? {
      person: position.person,
      types: new Set<string>()
    }
    held.types.add(position.typeName)
    people.set(position.person.userId, held)
  }
  if (people.size === 0) return null
  return (
    <View style={{ gap: theme.rem(0.75) }} testID="game-umpires">
      <View accessibilityRole="header">
        <SectionHeader title="Umpires" note={String(people.size)} />
      </View>
      {[...people.values()].map(({ person, types }) => (
        <Card
          flush
          key={person.userId}
          testID={`umpire-person-${person.userId}`}
        >
          <ListRow
            title={person.name}
            subtitle={[...types].join(', ')}
            subtitleNumberOfLines={0}
            emblem={initialsOf(person.name)}
            emblemUri={person.avatarUrl}
            emblemShape="circle"
          />
        </Card>
      ))}
    </View>
  )
}
