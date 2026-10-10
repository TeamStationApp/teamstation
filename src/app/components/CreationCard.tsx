import React from 'react'
import {
  Image,
  type ImageSourcePropType,
  Pressable,
  Text,
  View
} from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface CreationCardProps {
  title: string
  description: string
  icon: ImageSourcePropType
  onPress: () => void
}

export function CreationCard({
  title,
  description,
  icon,
  onPress
}: CreationCardProps): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={styles.card}
    >
      <View style={styles.heading}>
        <Image source={icon} style={styles.icon} resizeMode="contain" />
        <Text style={styles.title}>{title}</Text>
      </View>
      <Text style={styles.description}>{description}</Text>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    flex: 1,
    minWidth: 225,
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  heading: { alignItems: 'center' as const, marginBottom: 12 },
  icon: { width: 70, height: 70, marginBottom: 10 },
  title: {
    color: theme.primaryTextColor,
    fontSize: 20,
    fontWeight: '600' as const,
    textAlign: 'center' as const
  },
  description: {
    color: theme.secondaryTextColor,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'left' as const
  }
}))
