import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { Icon } from '../components'
import { GlassView } from '../components/GlassView'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'

/** Separate sibling targets keep latest navigation independent of attention. */
export function ChatAttentionControl(props: {
  count: number
  loading: boolean
  failed: boolean
  disabled: boolean
  bottom: number
  right: number
  onLatest: () => void
  onNext: () => void
  onRetry: () => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      testID="chat-attention-controls"
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        bottom: props.bottom,
        right: props.right,
        zIndex: 3,
        width: 196,
        height: 76
      }}
    >
      <GlassView
        testID="chat-latest-surface"
        style={{ position: 'absolute', right: 0, bottom: 0, borderRadius: 24 }}
      >
        <Pressable
          testID="chat-jump-latest"
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_latest}
          onPress={props.onLatest}
          style={{
            minHeight: 48,
            minWidth: 48,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <View style={{ transform: [{ rotate: '90deg' }] }}>
            <Icon name="chevron_right" color={theme.primaryTextColor} />
          </View>
        </Pressable>
      </GlassView>
      {props.loading ? (
        <Text
          testID="chat-attention-loading"
          accessibilityLiveRegion="polite"
          style={{
            color: theme.primaryTextColor,
            backgroundColor: theme.containerBackgroundColor,
            position: 'absolute',
            right: 56,
            bottom: 0,
            width: 140,
            padding: theme.rem(0.25)
          }}
        >
          {lstrings.chat_attention_loading}
        </Text>
      ) : props.failed ? (
        <Pressable
          testID="chat-attention-retry"
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_attention_retry}
          onPress={props.onRetry}
          style={{
            position: 'absolute',
            right: 56,
            bottom: 0,
            width: 140,
            minHeight: 44,
            justifyContent: 'center',
            backgroundColor: theme.containerBackgroundColor,
            paddingHorizontal: theme.rem(0.5)
          }}
        >
          <Text style={{ color: theme.primaryTextColor }}>
            {lstrings.common_retry}
          </Text>
        </Pressable>
      ) : props.count > 0 ? (
        <Pressable
          testID="chat-attention-count"
          accessibilityRole="button"
          accessibilityLabel={sprintf(
            lstrings.chat_attention_count,
            props.count
          )}
          accessibilityState={{ disabled: props.disabled }}
          disabled={props.disabled}
          onPress={props.onNext}
          style={{
            position: 'absolute',
            bottom: 32,
            right: 2,
            minWidth: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <View
            style={{
              minWidth: 24,
              minHeight: 24,
              borderRadius: 12,
              paddingHorizontal: 6,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.chatAttentionBackgroundColor
            }}
          >
            <Text
              style={{
                color: theme.chatAttentionTextColor,
                fontFamily: theme.boldTextFont,
                fontSize: theme.rem(0.75)
              }}
            >
              {props.count}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}
