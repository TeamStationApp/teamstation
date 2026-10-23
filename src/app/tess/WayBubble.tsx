import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The places on the way, from a label like `Home › Comets › Settings`. */
export function waySegments(label: string): string[] {
  return label
    .split('›')
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/**
 * "Show the way": the screens leading to a place, separated by chevrons and
 * ending in one, as a bubble that goes there. A long way wraps inside the
 * bubble rather than running past the column; the ends stay as round as a
 * one-line pill's and the padding clears them.
 */
export function WayBubble({
  label,
  path,
  onNavigate
}: {
  label: string
  path: string
  onNavigate: (path: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const segments = waySegments(label)
  return (
    <Pressable
      testID="Tess way"
      accessibilityRole="link"
      accessibilityLabel={sprintf(lstrings.tess_way, segments.join(', '))}
      onPress={() => {
        onNavigate(path)
      }}
      style={({ pressed }) => [styles.bubble, pressed && styles.pressed]}
    >
      {segments.map((segment, index) => (
        <View key={index} style={styles.step}>
          <Text style={styles.label}>{segment}</Text>
          <Icon name="chevron_right" size={1} color={theme.pillTextColor} />
        </View>
      ))}
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => {
  const height = theme.rem(2.25)
  return {
    bubble: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      minHeight: height,
      borderRadius: height / 2,
      paddingHorizontal: pillPadding(height),
      paddingVertical: theme.rem(0.25),
      backgroundColor: theme.pillBackground,
      rowGap: theme.rem(0.125)
    },
    step: { flexDirection: 'row', alignItems: 'center' },
    label: {
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.875),
      fontWeight: '600',
      color: theme.pillTextColor
    },
    pressed: { backgroundColor: theme.pillPressedBackground }
  } as const
})
