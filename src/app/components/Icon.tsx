import React from 'react'
import { Text } from 'react-native'

import { fonts } from '../theme/fonts'
import { useTheme } from '../theme/ThemeContext'
import { iconText } from './iconText'

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
  | 'skip_previous'
  | 'format_list_bulleted'
  | 'bookmark'
  | 'share'
  | 'mail'
  | 'star'
  | 'table_chart'
  | 'videocam'
  | 'refresh'
  | 'settings'
  | 'close'
  | 'content_copy'
  | 'forward_10'
  | 'replay_10'
  | 'fullscreen'
  | 'music_note'
  | 'description'
  | 'stop'
  | 'mic'
  | 'mic_off'
  | 'volume_off'
  | 'volume_up'
  | 'pause'
  | 'notifications'
  | 'search'
  | 'filter_alt'
  | 'edit'
  | 'place'
  | 'auto_awesome'
  | 'add'
  | 'send'
  | 'attach_file'
  | 'chat'
  | 'add_reaction'
  | 'mood'
  | 'lock'
  | 'key'
  | 'group'

export interface IconProps {
  name: IconName
  /** In rem, like everything else. Defaults to a comfortable inline size. */
  size?: number
  color?: string
}

/**
 * Material Symbols draws an icon from its name on the web. A phone draws the
 * character `iconText` returns, because the name is what appears as letters
 * when that substitution does not happen.
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
        fontFamily: fonts.materialSymbols,
        fontSize: theme.rem(size),
        lineHeight: theme.rem(size),
        // The line box is exactly the glyph, which is what keeps an icon
        // centred in a row rather than sitting on a line of invisible
        // descender space. Android adds that space back by default and then
        // clips the glyph to the line height, so the top and bottom of every
        // icon are shaved off; this is the switch that turns it off. It does
        // nothing on the web, where there is no such padding to begin with.
        includeFontPadding: false,
        color
      }}
    >
      {iconText(name)}
    </Text>
  )
}
