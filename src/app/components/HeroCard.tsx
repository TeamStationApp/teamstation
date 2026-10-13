import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Card } from './Card'
import { Emblem } from './Emblem'
import { Icon } from './Icon'
import { initialsOf } from './initials'

export function HeroCard({
  name,
  secondary,
  uri,
  person = false,
  onEdit,
  disabled = false
}: {
  name: string
  secondary?: string | null
  uri?: string | null
  person?: boolean
  onEdit?: () => void
  disabled?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const emblem = (
    <Emblem
      key={uri}
      uri={uri}
      fallback={initialsOf(name)}
      shape={person ? 'circle' : 'rounded'}
      size={3.5}
    />
  )
  const label = `${uri == null || uri === '' ? 'Add' : 'Change'} ${person ? 'photo' : 'picture'}`
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
            <Icon name="edit" size={1} />
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
