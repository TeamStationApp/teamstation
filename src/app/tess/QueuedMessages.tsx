import React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AttachmentChip } from './TessMessage'
import type { QueuedMessage } from './tessQueue'

export interface QueuedMessagesProps {
  queued: readonly QueuedMessage[]
  /** The arrow: stop Tess and send this one now. */
  onSendNow: (id: string) => void
  /** The X: take it out of the queue. */
  onRemove: (id: string) => void
  /** A press anywhere else: into the field, to edit. */
  onEdit: (id: string) => void
}

/**
 * The messages waiting for Tess, between the conversation and the composer,
 * so they stay where they are while her reply scrolls above them: one bubble
 * each, on the right like the person's own, in the order they go out. Each
 * has an X at its top right that removes it, and "queued" with an up arrow
 * at its bottom right that sends it now; a press anywhere else moves it into
 * the field to edit. One that failed going out says why, in red. Outlined
 * rather than filled, so a message waiting reads apart from one sent.
 */
export function QueuedMessages({
  queued,
  onSendNow,
  onRemove,
  onEdit
}: QueuedMessagesProps): React.ReactElement | null {
  const theme = useTheme()
  const styles = getStyles(theme)
  if (queued.length === 0) return null
  return (
    <ScrollView
      testID="Tess queue"
      style={styles.list}
      contentContainerStyle={styles.stack}
      keyboardShouldPersistTaps="handled"
    >
      {queued.map(message => (
        <View key={message.id} testID="Tess queued" style={styles.bubble}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sprintf(
              lstrings.tess_queue_edit,
              message.text === ''
                ? message.attachments.map(file => file.name).join(', ')
                : message.text
            )}
            onPress={() => {
              onEdit(message.id)
            }}
            style={({ pressed }) => [styles.body, pressed && styles.pressed]}
          >
            {message.attachments.length > 0 && (
              <View style={styles.chips}>
                {message.attachments.map(attachment => (
                  <AttachmentChip key={attachment.id} attachment={attachment} />
                ))}
              </View>
            )}
            {message.text !== '' && (
              <Text testID="Tess queued text" style={styles.text}>
                {message.text}
              </Text>
            )}
            {message.error != null && (
              <Text
                testID="Tess queued error"
                accessibilityLiveRegion="polite"
                style={styles.error}
              >
                {message.error}
              </Text>
            )}
            <Text style={styles.label}>{lstrings.tess_queued}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.tess_queue_remove}
            hitSlop={ICON_SLOP}
            onPress={() => {
              onRemove(message.id)
            }}
            style={({ pressed }) => [
              styles.icon,
              styles.remove,
              pressed && styles.pressed
            ]}
          >
            <Icon name="close" size={1} color={theme.secondaryTextColor} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.tess_queue_send_now}
            hitSlop={ICON_SLOP}
            onPress={() => {
              onSendNow(message.id)
            }}
            style={({ pressed }) => [
              styles.icon,
              styles.arrow,
              pressed && styles.pressed
            ]}
          >
            <Icon
              name="arrow_upward"
              size={1}
              color={theme.primaryButtonColor}
            />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  )
}

// Each icon is 24 points; its touch target is 44.
const ICON_SLOP = 10

const getStyles = cacheStyles((theme: Theme) => {
  const icon = theme.rem(1.5)
  const inset = theme.rem(theme.spaceXsRem)
  return {
    // A long queue scrolls in its own space rather than push the
    // conversation off the screen.
    list: { flexGrow: 0, maxHeight: theme.rem(16) },
    stack: {
      gap: theme.rem(theme.spaceSmRem),
      paddingHorizontal: theme.rem(theme.spaceMdRem),
      paddingVertical: theme.rem(theme.spaceSmRem)
    },
    bubble: {
      alignSelf: 'flex-end',
      maxWidth: '85%',
      borderRadius: theme.rem(theme.radiusLargeRem),
      borderBottomRightRadius: theme.rem(theme.radiusSmallRem),
      borderWidth: 1,
      borderColor: theme.primaryButtonColor,
      backgroundColor: theme.cardBackgroundColor
    },
    // Clear of the X on the right and of the arrow under it.
    body: {
      gap: theme.rem(theme.spaceXsRem),
      paddingLeft: theme.rem(theme.spaceMdRem),
      paddingRight: icon + inset * 2,
      paddingTop: theme.rem(theme.spaceSmRem),
      paddingBottom: theme.rem(theme.spaceXsRem),
      borderRadius: theme.rem(theme.radiusLargeRem)
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: theme.rem(theme.spaceXsRem)
    },
    text: {
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9375),
      lineHeight: theme.rem(1.375),
      color: theme.primaryTextColor
    },
    error: {
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8125),
      color: theme.dangerColor
    },
    // On the arrow's line, just left of it.
    label: {
      alignSelf: 'flex-end',
      lineHeight: icon,
      fontFamily: theme.regularTextFont,
      fontStyle: 'italic',
      fontSize: theme.rem(0.75),
      color: theme.secondaryTextColor
    },
    icon: {
      position: 'absolute',
      right: inset,
      width: icon,
      height: icon,
      alignItems: 'center',
      justifyContent: 'center'
    },
    remove: { top: inset },
    arrow: { bottom: inset },
    pressed: { opacity: 0.6 }
  } as const
})
