import React, { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

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
  const [query, setQuery] = useState('')
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
      onClose={props.onClose}
      initialField
      scene
      keyboardRows='[data-testid^="chat-mention-member-"]'
    >
      <TextField
        label={lstrings.chat_mention_search}
        value={query}
        onChangeText={setQuery}
        autoFocus
        onSubmitEditing={() => {
          const first = candidates[0]
          if (first != null) props.onSelect(first.userId)
        }}
      />
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
              props.onSelect(member.userId)
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
