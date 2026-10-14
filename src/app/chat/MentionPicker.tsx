import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Pressable, Text, type TextInput, View } from 'react-native'

import { TextField } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatActionOverlay } from './ChatActionOverlay'
import { ChatAvatar } from './ChatAvatar'
import { memberIdentity } from './chatIdentityModel'
import type { MemberView } from './engine/engine'

/** Search current members locally; the ID belongs to the selected row. */
export function MentionPicker(props: {
  members: readonly MemberView[]
  error?: string
  onSelect: (userId: number) => void
  onClose: () => void
}): React.ReactElement {
  const theme = useTheme()
  const { onSelect, onClose } = props
  const [query, setQuery] = useState('')
  const [closing, setClosing] = useState(false)
  const [searchHeight, setSearchHeight] = useState<number>()
  const [completion, setCompletion] = useState(0)
  const search = useRef<React.ComponentRef<typeof TextInput>>(null)
  const latest = useRef({ onSelect, onClose })
  latest.current = { onSelect, onClose }
  const live = useRef(true)
  const pending = useRef<{ userId: number } | 'cancel' | undefined>(undefined)
  const phase = useRef<'idle' | 'closing' | 'settled'>('idle')
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    if (phase.current !== 'settled') return
    // A rejected insertion keeps this picker mounted. Restore its Search only
    // after the callback's commit; successful selection unmounts the picker.
    phase.current = 'idle'
    setClosing(false)
  }, [completion])
  const invoke = (choice: { userId: number } | 'cancel'): void => {
    if (choice === 'cancel') latest.current.onClose()
    else latest.current.onSelect(choice.userId)
  }
  const request = (choice: { userId: number } | 'cancel'): void => {
    if (Platform.OS === 'web') {
      invoke(choice)
      return
    }
    if (phase.current !== 'idle') {
      if (phase.current === 'closing' && choice === 'cancel')
        pending.current = choice
      return
    }
    pending.current = choice
    phase.current = 'closing'
    setClosing(true)
  }
  const finish = (): void => {
    const choice = pending.current
    if (!live.current || phase.current !== 'closing' || choice == null) return
    pending.current = undefined
    phase.current = 'settled'
    // Search is already unmounted and the background host is released.
    invoke(choice)
    if (live.current) setCompletion(value => value + 1)
  }
  const candidates = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return [
      ...new Map(props.members.map(member => [member.userId, member])).values()
    ]
      .filter(member =>
        `${member.shortName} ${member.label}`
          .toLocaleLowerCase()
          .includes(search)
      )
      .sort((a, b) => {
        const name = a.shortName.localeCompare(b.shortName)
        return name !== 0 ? name : a.userId - b.userId
      })
  }, [props.members, query])
  return (
    <ChatActionOverlay
      label={lstrings.chat_mention_title}
      onClose={() => {
        request('cancel')
      }}
      closing={closing}
      focusHandoff={closing}
      onClosed={finish}
      initialField
      scene
      onEntered={() => {
        // A field focused while the scene slides in from below makes iOS
        // scroll the chooser by the slide when the keyboard is already up.
        if (Platform.OS !== 'web') search.current?.focus()
      }}
      keyboardRows='[data-testid^="chat-mention-member-"]'
    >
      <View
        onLayout={event => {
          setSearchHeight(event.nativeEvent.layout.height)
        }}
        style={closing ? { height: searchHeight } : undefined}
      >
        {!closing && (
          <TextField
            label={lstrings.chat_mention_search}
            value={query}
            onChangeText={setQuery}
            inputRef={search}
            autoFocus={Platform.OS === 'web'}
            onSubmitEditing={() => {
              const first = candidates[0]
              if (first != null) request({ userId: first.userId })
            }}
          />
        )}
      </View>
      {props.error != null && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.dangerColor }}
        >
          {props.error}
        </Text>
      )}
      <View>
        {candidates.map((member, index) => (
          <Pressable
            key={member.userId}
            testID={`chat-mention-member-${member.userId}`}
            accessibilityRole="button"
            accessibilityLabel={`${member.shortName}, ${member.label}`}
            onPress={() => {
              request({ userId: member.userId })
            }}
            style={{
              minHeight: 48,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.rem(0.75),
              paddingVertical: theme.rem(0.625),
              paddingHorizontal: theme.rem(0.25),
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: theme.defaultBorderColor
            }}
          >
            <ChatAvatar identity={memberIdentity(member)} size={2.25} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontFamily: theme.semiBoldTextFont,
                  fontSize: theme.rem(1),
                  color: theme.primaryTextColor
                }}
              >
                {member.shortName}
              </Text>
              <Text
                style={{
                  fontFamily: theme.regularTextFont,
                  fontSize: theme.rem(0.8125),
                  color: theme.secondaryTextColor
                }}
              >
                {member.label}
              </Text>
            </View>
          </Pressable>
        ))}
        {candidates.length === 0 && (
          <Text
            style={{
              paddingVertical: theme.rem(0.75),
              color: theme.secondaryTextColor
            }}
          >
            {lstrings.chat_mention_none}
          </Text>
        )}
      </View>
    </ChatActionOverlay>
  )
}
