import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import {
  normalizeTag,
  type TagChoices,
  type TagTarget
} from '../../common/eventTags'
import { useTheme } from '../theme/ThemeContext'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'
import { ScoringTextInput } from './ScoringTextInput'

export function TagPill({
  tag,
  onPress
}: {
  tag: string
  onPress?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const content = (
    <Text
      style={{
        color: theme.pillTextColor,
        fontFamily: theme.regularTextFont,
        fontSize: 14
      }}
    >
      {tag}
    </Text>
  )
  const style = {
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    borderRadius: theme.radiusPill,
    backgroundColor: theme.pillBackground,
    minHeight: onPress == null ? undefined : 44,
    justifyContent: 'center' as const,
    paddingHorizontal: 22,
    paddingVertical: 6,
    maxWidth: '100%' as const,
    flexShrink: 0
  }
  return onPress == null ? (
    <View style={style}>{content}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Use tag ${tag}`}
      onPress={onPress}
      style={style}
    >
      {content}
    </Pressable>
  )
}

/**
 * Puts a tag on a play or one of its events, or takes it off. Saving closes
 * the editor at once: the tag is written behind it (on a phone, queued on
 * the game), and a save that fails says so through `onFailed`.
 */
export function EventTagEditor({
  target,
  loadChoices,
  saveTag,
  onClose,
  onFailed
}: {
  target: TagTarget
  loadChoices: () => Promise<TagChoices>
  saveTag: (tag: string | null) => Promise<void>
  onClose: () => void
  /** A save the editor no longer shows, which failed. */
  onFailed?: (message: string) => void
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const [input, setInput] = useState(target.tag ?? '')
  const edited = useRef(false)
  useEffect(() => {
    if (!edited.current) setInput(target.tag ?? '')
  }, [target.tag])
  const [choices, setChoices] = useState<TagChoices>({
    recent: [],
    popular: []
  })
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const saved = useRef(false)
  useEffect(() => {
    active.current = true
    loadChoices()
      .then(value => {
        if (active.current) setChoices(value)
      })
      .catch((reason: unknown) => {
        if (active.current)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Tags could not be loaded. Try again.'
          )
      })
    return () => {
      active.current = false
    }
  }, [loadChoices])
  const save = async (value: string | null): Promise<void> => {
    if (saved.current) return
    let tag: string | null = null
    try {
      tag = value == null ? null : normalizeTag(value)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enter a tag')
      return
    }
    // Once: the editor closes now, and the save goes on behind it.
    saved.current = true
    setError(null)
    onClose()
    try {
      await saveTag(tag)
    } catch (reason) {
      onFailed?.(
        reason instanceof Error
          ? reason.message
          : 'Tag could not be saved. Try again.'
      )
    }
  }
  const pills = (labels: string[]): React.ReactElement => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {labels.map(tag => (
        <TagPill
          key={tag}
          tag={tag}
          onPress={() => {
            save(tag).catch(() => undefined)
          }}
        />
      ))}
    </View>
  )
  return (
    <ScoringSheet title={target.title} onClose={onClose} swipeToDismiss>
      <View style={{ gap: 16, padding: 16 }}>
        {target.description !== '' && (
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.regularTextFont,
              fontSize: 15
            }}
          >
            {target.description}
          </Text>
        )}
        <Text
          style={{
            color: theme.primaryTextColor,
            fontFamily: theme.regularTextFont,
            fontSize: 14
          }}
        >
          New tag · One or two words
        </Text>
        <ScoringTextInput
          accessibilityLabel="New tag"
          value={input}
          onChangeText={value => {
            edited.current = true
            setInput(value)
          }}
          multiline={false}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => {
            save(input).catch(() => undefined)
          }}
        />
        {error != null && (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.dangerColor, fontSize: 14 }}
          >
            {error}
          </Text>
        )}
        <ScoringButton
          label="Save tag"
          onPress={() => {
            save(input).catch(() => undefined)
          }}
        />
        {target.tag != null && (
          <ScoringButton
            label="Remove tag"
            onPress={() => {
              save(null).catch(() => undefined)
            }}
          />
        )}
        {choices.recent.length > 0 && (
          <View style={{ gap: 8 }}>
            <Text
              style={{
                color: theme.primaryTextColor,
                fontSize: 16,
                fontWeight: '700'
              }}
            >
              Recent tags
            </Text>
            {pills(choices.recent)}
          </View>
        )}
        {choices.popular.length > 0 && (
          <View style={{ gap: 8 }}>
            <Text
              style={{
                color: theme.primaryTextColor,
                fontSize: 16,
                fontWeight: '700'
              }}
            >
              Popular tags
            </Text>
            {pills(choices.popular.map(item => item.tag))}
          </View>
        )}
      </View>
    </ScoringSheet>
  )
}
