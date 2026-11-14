import React from 'react'
import {
  Platform,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View
} from 'react-native'

import { rosterNameLines, type RosterNamePlayer } from './rosterNameLines'

/** A space's width in the app's font, as a share of its size. */
const SPACE_WIDTH = 0.26

/**
 * A roster or lineup card's name at its own size, never shrunk: the slot,
 * jersey and first name, and the last name beside them when both fit on
 * one line, else on a second line of its own. Each line that is still too
 * wide ends in an ellipsis. A one-word name wraps onto two lines.
 */
export function RosterName({
  player,
  prefix,
  style
}: {
  player: RosterNamePlayer
  /** The lineup's slot, `1.`. */
  prefix?: string
  style: StyleProp<TextStyle>
}): React.ReactElement {
  const { first, last } = rosterNameLines(player, prefix)
  // The space between the names is the row's gap, which falls only between
  // texts that share a line, so a wrapped first line spends none of its
  // width on it.
  const gap = (StyleSheet.flatten(style)?.fontSize ?? 14) * SPACE_WIDTH
  // No wider than the card, so its grip and remove button stay in it.
  const line = [style, { flexShrink: 1, minWidth: 0 }]
  if (last === '')
    return (
      <Text
        selectable={false}
        numberOfLines={2}
        style={[style, { flex: 1, minWidth: 0 }]}
      >
        {first}
      </Text>
    )
  return (
    <View
      testID="Roster name"
      style={{
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: gap
      }}
    >
      {/* On the web the first line also ends in the space, which a browser
          draws as nothing there, so the card's text reads the whole name. */}
      <Text selectable={false} numberOfLines={1} style={line}>
        {Platform.OS === 'web' ? `${first} ` : first}
      </Text>
      <Text selectable={false} numberOfLines={1} style={line}>
        {last}
      </Text>
    </View>
  )
}
