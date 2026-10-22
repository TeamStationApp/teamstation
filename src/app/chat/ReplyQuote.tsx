import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { MessagePressGesture } from './chatInteractionModel'
import type { QuoteView } from './engine/apply'

export function ReplyQuote(props: {
  quote: QuoteView
  userId?: string
  onJump?: (id: string) => void
  messageGesture?: MessagePressGesture
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const name =
    props.quote.status === 'unavailable'
      ? lstrings.chat_former_member
      : props.quote.authorId === props.userId
        ? lstrings.chat_you
        : (props.quote.authorName ?? lstrings.chat_former_member)
  const contents = (
    <>
      <Text style={styles.name}>{name}</Text>
      <Text style={styles.text} numberOfLines={3}>
        {props.quote.snippet}
      </Text>
    </>
  )
  if (props.onJump == null) return <View style={styles.quote}>{contents}</View>
  return (
    <Pressable
      {...props.messageGesture?.pressProps}
      accessibilityRole="button"
      accessibilityLabel={sprintf(
        lstrings.chat_jump_reply,
        name,
        props.quote.snippet
      )}
      onPress={event => {
        if (props.messageGesture?.canOpen(event) === false) return
        props.onJump?.(props.quote.id)
      }}
      style={styles.quote}
    >
      {contents}
    </Pressable>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: theme.activeColor,
    borderRadius: theme.rem(0.375),
    backgroundColor: theme.containerBackgroundColor,
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.375),
    gap: theme.rem(0.125)
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    color: theme.activeColor
  },
  text: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  }
}))
