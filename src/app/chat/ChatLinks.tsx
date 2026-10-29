import React, { useEffect } from 'react'
import { Text, View } from 'react-native'

import { ListCard, ListRow, SectionHeader } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** An accessible conversation linked from its owning group. */
export interface ChatLink {
  id: string
  title: string
  label?: string
  preview?: string
}

export interface ChatLinksProps {
  chats: ChatLink[]
  onOpen?: (chat: ChatLink) => void
  onLoadPreview?: (ids: string[]) => void
}

/** One bounded collection, with previews supplied only after authentication. */
export function ChatLinks(props: ChatLinksProps): React.ReactElement {
  const { chats, onOpen, onLoadPreview } = props
  const styles = getStyles(useTheme())
  useEffect(() => {
    onLoadPreview?.(chats.map(chat => chat.id))
  }, [chats, onLoadPreview])
  return (
    <View style={styles.section} testID="entity-chats">
      <SectionHeader title={lstrings.chat_chats} />
      {chats.length === 0 ? (
        <Text style={styles.empty}>No chats available.</Text>
      ) : (
        <ListCard testID="entity-chat-list">
          {chats.map(chat => (
            <ListRow
              key={chat.id}
              testID={`entity-chat-${chat.id}`}
              title={chat.label ?? chat.title}
              subtitle={chat.preview}
              emblemIcon="chat"
              accessibilityLabel={sprintf(
                lstrings.chat_open_chat,
                chat.label ?? chat.title
              )}
              onPress={() => onOpen?.(chat)}
            />
          ))}
        </ListCard>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(theme.spaceMdRem) },
  empty: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  }
}))
