import React from 'react'
import { Text } from 'react-native'

import { useTheme } from '../theme/ThemeContext'

/**
 * The icons the app uses, by the name Material Symbols knows them.
 *
 * A closed list rather than a free string, so that a name that does not exist
 * cannot reach a screen. A missing symbol renders as its own name in words —
 * `chevron_right` spelled out in the middle of a row — which is the kind of
 * thing that survives a review because it only appears in the running app.
 */
export type IconName =
  | 'chevron_right'
  | 'chevron_left'
  | 'home'
  | 'smart_display'
  | 'event'
  | 'account_circle'
  | 'groups'
  | 'leaderboard'
  | 'sports_baseball'
  | 'stadium'
  | 'play_circle'
  | 'play_arrow'
  | 'format_list_bulleted'
  | 'bookmark'
  | 'share'
  | 'mail'
  | 'star'
  | 'table_chart'
  | 'videocam'

export interface IconProps {
  name: IconName
  /** In rem, like everything else. Defaults to a comfortable inline size. */
  size?: number
  color?: string
}

/**
 * Material Symbols is a ligature font: the text `chevron_right` is drawn as
 * the glyph. That means no icon components, no sprite sheet and no build step —
 * and it means the name in the source is the name in the design.
 */
export function Icon(props: IconProps): React.ReactElement {
  const theme = useTheme()
  const { name, size = 1.25, color = theme.primaryTextColor } = props
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      selectable={false}
      style={{
        fontFamily: 'Material Symbols Outlined',
        fontSize: theme.rem(size),
        lineHeight: theme.rem(size),
        color
      }}
    >
      {name}
    </Text>
  )
}
