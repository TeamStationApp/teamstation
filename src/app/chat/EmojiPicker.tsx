import compact from 'emojibase-data/en/compact.json'
import messages from 'emojibase-data/en/messages.json'
import React, { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * The emoji picker: every emoji `emojibase-data` (pinned) knows, a group at
 * a time, or every match for a word typed into its search. Emoji are plain
 * Unicode in the message, so picking one only hands its characters back.
 */

export interface PickerEmoji {
  unicode: string
  label: string
  group: number
  tags: string[]
}

interface CompactEmoji {
  unicode: string
  label: string
  group?: number
  order?: number
  tags?: string[]
}

/** The `component` group: skin tones and hair, never sent on their own. */
const COMPONENT_GROUP = 2

/** Every emoji the picker offers, in emojibase's order. */
export const EMOJI: PickerEmoji[] = (compact as CompactEmoji[])
  .filter(
    emoji =>
      emoji.group != null &&
      emoji.group !== COMPONENT_GROUP &&
      emoji.order != null
  )
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map(emoji => ({
    unicode: emoji.unicode,
    label: emoji.label,
    group: emoji.group ?? 0,
    tags: emoji.tags ?? []
  }))

/** The groups, with emojibase's own names for them. */
export const EMOJI_GROUPS: Array<{ id: number; name: string }> = (
  messages as { groups: Array<{ order: number; message: string }> }
).groups
  .filter(group => group.order !== COMPONENT_GROUP)
  .map(group => ({
    id: group.order,
    name: group.message.charAt(0).toUpperCase() + group.message.slice(1)
  }))

/** Every emoji whose name or tags hold `query`, at most `limit`. */
export function searchEmoji(query: string, limit = 120): PickerEmoji[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return []
  const found: PickerEmoji[] = []
  for (const emoji of EMOJI) {
    if (
      emoji.label.toLowerCase().includes(wanted) ||
      emoji.tags.some(tag => tag.startsWith(wanted))
    ) {
      found.push(emoji)
      if (found.length >= limit) break
    }
  }
  return found
}

export interface EmojiPickerProps {
  onPick: (emoji: string) => void
  onClose: () => void
}

export function EmojiPicker(props: EmojiPickerProps): React.ReactElement {
  const { onPick, onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [group, setGroup] = useState(EMOJI_GROUPS[0]?.id ?? 0)
  const [query, setQuery] = useState('')
  const shown = useMemo(
    () =>
      query.trim() === ''
        ? EMOJI.filter(emoji => emoji.group === group)
        : searchEmoji(query),
    [group, query]
  )

  return (
    <View style={styles.picker} accessibilityLabel={lstrings.chat_emoji}>
      <View style={styles.top}>
        <TextInput
          accessibilityLabel={lstrings.chat_more_emoji}
          value={query}
          onChangeText={setQuery}
          placeholder="Search emoji"
          placeholderTextColor={theme.placeholderTextColor}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.search}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_cancel}
          onPress={onClose}
          style={styles.close}
        >
          <Text style={styles.closeText}>{lstrings.chat_cancel}</Text>
        </Pressable>
      </View>
      {query.trim() === '' && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.groups}
        >
          {EMOJI_GROUPS.map(entry => (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: entry.id === group }}
              accessibilityLabel={entry.name}
              onPress={() => {
                setGroup(entry.id)
              }}
              style={[styles.group, entry.id === group && styles.groupOn]}
            >
              <Text
                style={[
                  styles.groupText,
                  entry.id === group && styles.groupTextOn
                ]}
              >
                {entry.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <ScrollView style={styles.gridScroll} keyboardShouldPersistTaps="handled">
        <View style={styles.grid}>
          {shown.map(emoji => (
            <Pressable
              key={emoji.unicode}
              accessibilityRole="button"
              accessibilityLabel={emoji.label}
              onPress={() => {
                onPick(emoji.unicode)
              }}
              style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
            >
              <Text style={styles.emoji}>{emoji.unicode}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  picker: {
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor,
    paddingTop: theme.rem(theme.spaceSmRem),
    gap: theme.rem(theme.spaceXsRem)
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem)
  },
  search: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    borderRadius: theme.rem(theme.radiusSmallRem),
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.375)
  },
  close: {
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.375)
  },
  closeText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.activeColor
  },
  groups: {
    gap: theme.rem(theme.spaceXsRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem)
  },
  group: {
    borderRadius: theme.rem(1),
    paddingHorizontal: theme.rem(0.625),
    paddingVertical: theme.rem(0.25),
    backgroundColor: theme.pillBackground
  },
  groupOn: {
    backgroundColor: theme.pillActiveBackground
  },
  groupText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.pillTextColor
  },
  groupTextOn: {
    color: theme.pillActiveTextColor
  },
  gridScroll: {
    maxHeight: theme.rem(13)
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: theme.rem(theme.spaceXsRem),
    paddingBottom: theme.rem(theme.spaceSmRem)
  },
  cell: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(theme.radiusSmallRem)
  },
  pressed: {
    backgroundColor: theme.containerBackgroundColor
  },
  emoji: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor
  }
}))
