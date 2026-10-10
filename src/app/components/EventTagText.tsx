import React from 'react'
import {
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View
} from 'react-native'

import { TagPill } from '../scoring/EventTagEditor'

/** Words flow normally; the multiword tag wraps as one complete boxed unit. */
export function EventTagText({
  text,
  tag,
  style,
  numberOfLines,
  fillRow = false
}: {
  text: string
  tag?: string | null
  style?: StyleProp<TextStyle>
  numberOfLines?: number
  fillRow?: boolean
}): React.ReactElement {
  if (tag == null)
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    )
  const words = text.split(/\s+/u)
  const wordStyle = { ...StyleSheet.flatten(style) }
  delete wordStyle.flex
  delete wordStyle.flexGrow
  delete wordStyle.flexShrink
  delete wordStyle.flexBasis
  return (
    <View
      accessible
      accessibilityLabel={`${text} ${tag}`}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        maxWidth: '100%',
        minWidth: 0,
        flex: fillRow ? 1 : undefined
      }}
    >
      {words.map((word, index) => (
        <Text
          key={index}
          style={[
            wordStyle,
            { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', maxWidth: '100%' }
          ]}
        >
          {word}{' '}
        </Text>
      ))}
      <TagPill tag={tag} />
    </View>
  )
}
