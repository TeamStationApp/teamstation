import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ButtonIcon } from './ButtonIcon'
import { Card } from './Card'
import { GroupEmblem } from './GroupEmblem'
import { PersonEmblem, type PersonEmblemProps } from './PersonEmblem'
import type { GroupTileSource } from './teamTile'

export function HeroCard({
  name,
  secondary,
  uri,
  onEdit,
  disabled = false,
  ...identity
}: {
  name: string
  secondary?: string | null
  uri?: string | null
  onEdit?: () => void
  disabled?: boolean
} & (
  | {
      /**
       * A person, drawn as their tile (`PersonEmblem`): a circle with the
       * initials of `name` on the colour their account id gives them.
       */
      person: Pick<PersonEmblemProps, 'userId'>
      group?: undefined
    }
  | {
      person?: undefined
      /**
       * A team, league or season, drawn as its tile (`GroupEmblem`); `uri` is
       * still its own picture, so a season without one is offered `Add
       * picture` while its league's is drawn.
       */
      group: Omit<GroupTileSource, 'name' | 'uri'>
    }
)): React.ReactElement {
  const styles = getStyles(useTheme())
  const { person, group } = identity
  const emblem =
    person != null ? (
      <PersonEmblem key={uri} {...person} name={name} uri={uri} size={3.5} />
    ) : (
      <GroupEmblem {...group} name={name} uri={uri} size={3.5} />
    )
  const label = `${uri == null || uri === '' ? 'Add' : 'Change'} ${person != null ? 'photo' : 'picture'}`
  return (
    <Card style={styles.card}>
      {onEdit == null ? (
        emblem
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onEdit}
          style={styles.emblem}
        >
          {emblem}
          <View style={styles.pencil}>
            <ButtonIcon name="edit" size={1} />
          </View>
        </Pressable>
      )}
      <View style={styles.identity}>
        <Text style={styles.name}>{name}</Text>
        {secondary != null && <Text style={styles.secondary}>{secondary}</Text>}
      </View>
    </Card>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(1)
  },
  emblem: { position: 'relative' as const },
  pencil: {
    position: 'absolute' as const,
    right: -theme.rem(0.125),
    bottom: -theme.rem(0.125),
    width: theme.rem(1.5),
    height: theme.rem(1.5),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.cardBackgroundColor,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  identity: { flex: 1, gap: theme.rem(0.25) },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.375),
    color: theme.primaryTextColor
  },
  secondary: { fontSize: theme.rem(0.9375), color: theme.secondaryTextColor }
}))
