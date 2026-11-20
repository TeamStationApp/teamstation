import React, { useEffect, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { base64 } from 'rfc4648'

import type { AttachmentRef } from '../../common/chatContent'
import type { ChatLinkPreview } from '../../common/chatLinkPreview'
import { ButtonIcon } from '../components/ButtonIcon'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import type { MessagePressGesture } from './chatInteractionModel'
import { chatLinkInteraction } from './ChatMessageText'

interface Props {
  preview: ChatLinkPreview
  onOpen?: (address: string) => void
  address?: string
  gesture?: MessagePressGesture
  onDismiss?: () => void
  loadThumbnail?: (
    ref: AttachmentRef,
    signal: AbortSignal
  ) => Promise<Uint8Array>
}
export function ChatLinkPreviewCard({
  preview,
  onOpen,
  address,
  gesture,
  onDismiss,
  loadThumbnail
}: Props): React.ReactElement {
  const theme = useTheme()
  const [image, setImage] = useState<{ ref: AttachmentRef; uri: string }>()
  const ref = preview.thumbnail
  useEffect(() => {
    if (ref == null || loadThumbnail == null) return
    const controller = new AbortController()
    loadThumbnail(ref, controller.signal)
      .then(bytes => {
        if (!controller.signal.aborted)
          setImage({
            ref,
            uri:
              'data:' + ref.contentType + ';base64,' + base64.stringify(bytes)
          })
      })
      .catch(() => {})
    return () => {
      controller.abort()
    }
  }, [ref, loadThumbnail])
  const visibleImage = image?.ref === ref ? image : undefined
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {ref != null && (
        <View style={{ width: 64, height: 56 }} accessible={false}>
          {visibleImage != null && (
            <Image
              testID={
                onDismiss != null
                  ? 'chat-draft-preview-thumbnail'
                  : 'chat-message-preview-thumbnail'
              }
              accessibilityIgnoresInvertColors
              source={{ uri: visibleImage.uri }}
              style={{ width: '100%', height: '100%', borderRadius: 6 }}
            />
          )}
        </View>
      )}
      <View style={{ flexShrink: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.secondaryTextColor, fontSize: 12 }}
        >
          {preview.siteName}
        </Text>
        {preview.title !== '' && (
          <Text
            numberOfLines={2}
            style={{ color: theme.primaryTextColor, fontWeight: '600' }}
          >
            {preview.title}
          </Text>
        )}
        {preview.description !== '' && (
          <Text numberOfLines={2} style={{ color: theme.secondaryTextColor }}>
            {preview.description}
          </Text>
        )}
      </View>
    </View>
  )
  return (
    <View
      testID="chat-link-preview"
      style={{
        padding: 8,
        borderStartWidth: 3,
        borderColor: theme.secondaryTextColor,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8
      }}
    >
      {onOpen != null && address != null ? (
        <Pressable
          {...chatLinkInteraction(address, onOpen, gesture)}
          testID={
            visibleImage == null
              ? undefined
              : 'chat-open-preview-with-thumbnail'
          }
          style={{ flexShrink: 1 }}
        >
          {body}
        </Pressable>
      ) : (
        <View style={{ flexShrink: 1 }}>{body}</View>
      )}
      {onDismiss != null && (
        <Pressable
          testID="chat-dismiss-link-preview"
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_remove_link_preview}
          onPress={onDismiss}
          hitSlop={8}
          style={{ marginStart: 'auto', padding: 6 }}
        >
          <ButtonIcon name="close" size={1} color={theme.secondaryTextColor} />
        </Pressable>
      )}
    </View>
  )
}
