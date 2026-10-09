import React, { useEffect, useRef } from 'react'
import { Pressable, Text, View } from 'react-native'

import { Icon } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { bindMessageTooltips, messageTooltipProps } from './chatWebInteractions'

export function MessageActions(props: {
  reply: boolean
  react: boolean
  onReply: () => void
  onReact: () => void
  onMore: (anchor: unknown) => void
  visible: boolean
}): React.ReactElement {
  const theme = useTheme()
  const controls = useRef<React.ComponentRef<typeof View>>(null)
  useEffect(
    () => bindMessageTooltips(controls.current),
    [props.reply, props.react]
  )
  const button = (
    label: string,
    content: React.ReactNode,
    press: (anchor: unknown) => void
  ): React.ReactElement => (
    <Pressable
      {...messageTooltipProps(label)}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={event => {
        press(event.currentTarget)
      }}
      style={{
        padding: theme.rem(0.375),
        borderRadius: theme.rem(0.5),
        backgroundColor: theme.cardBackgroundColor
      }}
    >
      {content}
    </Pressable>
  )
  return (
    <View
      ref={controls}
      style={{
        flexDirection: 'row',
        gap: theme.rem(0.125),
        opacity: props.visible ? 1 : 0
      }}
    >
      {props.reply &&
        button(
          lstrings.chat_reply,
          <Text
            style={{ color: theme.primaryTextColor, fontSize: theme.rem(1) }}
          >
            ↩
          </Text>,
          props.onReply
        )}
      {props.react &&
        button(
          lstrings.chat_send_emoji,
          <Icon name="mood" size={1} color={theme.primaryTextColor} />,
          props.onReact
        )}
      {button(
        lstrings.chat_more_message_actions,
        <Text style={{ color: theme.primaryTextColor }}>•••</Text>,
        props.onMore
      )}
    </View>
  )
}
