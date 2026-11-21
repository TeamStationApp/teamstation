import React from 'react'
import { View } from 'react-native'

import type { UmpireGameBlock } from '../../common/umpireSchedule'
import { Card, ListRow, SectionHeader } from '../components'
import { useTheme } from '../theme/ThemeContext'

export function GameUmpires({
  umpires,
  onOpenPerson
}: {
  umpires: UmpireGameBlock | null
  /**
   * Opens an umpire's league card; given only when the block names its
   * league, which comes only to a reader who may open those cards.
   */
  onOpenPerson?: (userId: string, name: string) => void
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
  const onPerson = umpires?.leagueId == null ? undefined : onOpenPerson
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
            person={{
              userId: person.userId,
              uri: person.avatarUrl
            }}
            onPress={
              onPerson == null || person.openable !== true
                ? undefined
                : () => {
                    onPerson(person.userId, person.name)
                  }
            }
          />
        </Card>
      ))}
    </View>
  )
}
