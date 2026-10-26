import React from 'react'
import { Text, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ChangeCard } from './ChangeCard'
import { TessMarkdown } from './TessMarkdown'
import { TessThinking } from './TessThinking'
import type { TessAttachmentRef, TessMessage as Message } from './tessTypes'
import type { TessLive } from './useTess'

/**
 * One message: the user's words in a bubble on the right with the files they
 * attached, or Tess's reply on the left, under a row for her thinking and
 * her steps when she took any, with a card for each change it proposes.
 */
export function TessMessage({
  message,
  onNavigate,
  onConfirm,
  holdDisabled = false,
  thoughtSeconds
}: {
  message: Message
  onNavigate: (path: string) => void
  onConfirm: (changeId: string) => void
  /** Tess is answering: her cards take no hold until she has. */
  holdDisabled?: boolean
  /** How long she thought on this reply, when the chat saw her do it. */
  thoughtSeconds?: number
}): React.ReactElement {
  const styles = getStyles(useTheme())
  if (message.role === 'user')
    return (
      <View testID="Tess user message" style={styles.user}>
        {message.attachments.length > 0 && (
          <View style={styles.chips}>
            {message.attachments.map(attachment => (
              <AttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </View>
        )}
        {message.text !== '' && (
          <View style={styles.bubble}>
            <Text selectable style={styles.userText}>
              {message.text}
            </Text>
          </View>
        )}
      </View>
    )
  return (
    <View testID="Tess reply" style={styles.reply}>
      {(message.thinking != null || (message.steps ?? []).length > 0) && (
        <TessThinking
          thinking={message.thinking}
          steps={message.steps}
          seconds={thoughtSeconds}
        />
      )}
      <TessMarkdown text={message.text} onNavigate={onNavigate} />
      {message.changes.map(change => (
        <ChangeCard
          key={change.id}
          change={change}
          onConfirm={onConfirm}
          holdDisabled={holdDisabled}
        />
      ))}
    </View>
  )
}

/**
 * The reply Tess is working on: her thinking and her steps, open, and her
 * text as it arrives, drawn as Markdown each time it grows.
 */
export function TessLiveReply({
  live,
  onNavigate
}: {
  live: TessLive
  onNavigate: (path: string) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View testID="Tess live reply" style={styles.reply}>
      <TessThinking live thinking={live.thinking} steps={live.steps} />
      {live.text.trim() !== '' && (
        <View testID="Tess live text">
          <TessMarkdown text={live.text} onNavigate={onNavigate} />
        </View>
      )}
    </View>
  )
}

/** A file on a message, by name; a described one says so. */
export function AttachmentChip({
  attachment,
  children
}: {
  attachment: Pick<TessAttachmentRef, 'name'> & { described?: boolean }
  /** A remove button, in the composer. */
  children?: React.ReactNode
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <View testID="Tess attachment" style={styles.chip}>
      <Icon name="attach_file" size={1} color={theme.secondaryTextColor} />
      <Text numberOfLines={1} style={styles.chipText}>
        {attachment.described === true
          ? sprintf(lstrings.tess_attach_described, attachment.name)
          : attachment.name}
      </Text>
      {children}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => {
  const chipHeight = theme.rem(2)
  return {
    user: {
      alignSelf: 'flex-end',
      alignItems: 'flex-end',
      maxWidth: '85%',
      gap: theme.rem(theme.spaceXsRem)
    },
    bubble: {
      paddingHorizontal: theme.rem(theme.spaceMdRem),
      paddingVertical: theme.rem(theme.spaceSmRem),
      borderRadius: theme.rem(theme.radiusLargeRem),
      borderBottomRightRadius: theme.rem(theme.radiusSmallRem),
      backgroundColor: theme.primaryButtonColor
    },
    userText: {
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9375),
      lineHeight: theme.rem(1.375),
      color: theme.buttonTextColor
    },
    reply: {
      alignSelf: 'stretch',
      gap: theme.rem(theme.spaceSmRem)
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: theme.rem(theme.spaceXsRem)
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.rem(theme.spaceXsRem),
      maxWidth: theme.rem(16),
      height: chipHeight,
      borderRadius: chipHeight / 2,
      paddingHorizontal: pillPadding(chipHeight),
      borderWidth: 1,
      borderColor: theme.defaultBorderColor,
      backgroundColor: theme.cardBackgroundColor
    },
    chipText: {
      flexShrink: 1,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8125),
      color: theme.primaryTextColor
    }
  } as const
})
