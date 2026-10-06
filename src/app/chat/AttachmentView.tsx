import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native'

import type { AttachmentRef } from '../../common/chatContent'
import { Icon } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { placeholderSize, sizeLabel } from './chatModel'
import { ChatVideo } from './ChatVideo'
import type { ChatScreenEngine } from './screenEngine'

/** What the attachment views need of a platform's file twin. */
export interface ChatFileOps {
  bytesUri: (
    bytes: Uint8Array,
    contentType: string,
    fileName: string
  ) => Promise<string>
  releaseUri: (uri: string) => Promise<void>
  saveFile: (
    bytes: Uint8Array,
    contentType: string,
    fileName: string
  ) => Promise<void>
}

export interface AttachmentViewProps {
  attachment: AttachmentRef
  engine: Pick<ChatScreenEngine, 'openAttachment'>
  files: ChatFileOps
  /** The widest the picture may draw, in pixels. */
  maxWidth: number
}

/** Opened bytes as a URL, released when the view goes. */
function useOpened(
  attachment: AttachmentRef,
  engine: AttachmentViewProps['engine'],
  files: ChatFileOps,
  wanted: boolean
): { uri: string | undefined; failed: boolean } {
  const [uri, setUri] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!wanted) return
    let live = true
    let made: string | undefined
    setFailed(false)
    engine
      .openAttachment(attachment)
      .then(
        async bytes =>
          await files.bytesUri(
            bytes,
            attachment.contentType,
            attachment.fileName
          )
      )
      .then(next => {
        made = next
        if (live) setUri(next)
        else files.releaseUri(next).catch(() => undefined)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
      if (made != null) files.releaseUri(made).catch(() => undefined)
    }
  }, [attachment, engine, files, wanted])
  return { uri, failed }
}

/**
 * One attachment in a bubble. A picture shows at once as a neutral box of
 * its own proportions, then its decrypted self. A video shows its name
 * until tapped, then decrypts and plays. Any other file saves (or, on a
 * phone, goes to the share sheet) when tapped.
 */
export function AttachmentView(props: AttachmentViewProps): React.ReactElement {
  const { attachment, engine, files, maxWidth } = props
  const shown = { attachment, engine, files, maxWidth }
  if (attachment.contentType.startsWith('image/')) {
    return <PictureAttachment {...shown} />
  }
  if (attachment.contentType.startsWith('video/')) {
    return <VideoAttachment {...shown} />
  }
  return (
    <FileAttachment attachment={attachment} engine={engine} files={files} />
  )
}

function PictureAttachment(props: AttachmentViewProps): React.ReactElement {
  const { attachment, engine, files, maxWidth } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { uri, failed } = useOpened(attachment, engine, files, true)
  const size = placeholderSize(
    attachment.width,
    attachment.height,
    maxWidth,
    theme.rem(20)
  )
  return (
    <View
      style={[styles.picture, size]}
      accessibilityLabel={attachment.fileName}
    >
      {uri != null ? (
        <Image
          accessibilityLabel={attachment.fileName}
          source={{ uri }}
          style={size}
          resizeMode="cover"
        />
      ) : failed ? (
        <Text style={styles.failed}>{lstrings.chat_attachment_failed}</Text>
      ) : null}
    </View>
  )
}

function VideoAttachment(props: AttachmentViewProps): React.ReactElement {
  const { attachment, engine, files, maxWidth } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [wanted, setWanted] = useState(false)
  const { uri, failed } = useOpened(attachment, engine, files, wanted)
  // A video's box is 16:9 when the sender's picker said nothing of it.
  const size =
    attachment.width == null || attachment.height == null
      ? { width: maxWidth, height: Math.round((maxWidth * 9) / 16) }
      : placeholderSize(
          attachment.width,
          attachment.height,
          maxWidth,
          theme.rem(20)
        )
  if (uri != null) {
    return (
      <ChatVideo
        uri={uri}
        width={size.width}
        height={size.height}
        label={attachment.fileName}
      />
    )
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sprintf(
        lstrings.chat_open_attachment,
        attachment.fileName
      )}
      onPress={() => {
        setWanted(true)
      }}
      style={[styles.picture, styles.video, size]}
    >
      {wanted && !failed ? (
        <ActivityIndicator color={theme.secondaryTextColor} />
      ) : (
        <Icon name="play_circle" size={2.5} color={theme.secondaryTextColor} />
      )}
      <Text style={styles.name} numberOfLines={1}>
        {attachment.fileName}
      </Text>
      <Text style={styles.size}>
        {failed ? lstrings.chat_attachment_failed : sizeLabel(attachment.size)}
      </Text>
    </Pressable>
  )
}

function FileAttachment(
  props: Omit<AttachmentViewProps, 'maxWidth'>
): React.ReactElement {
  const { attachment, engine, files } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sprintf(lstrings.chat_save_file, attachment.fileName)}
      onPress={() => {
        setBusy(true)
        setFailed(false)
        engine
          .openAttachment(attachment)
          .then(async bytes => {
            await files.saveFile(
              bytes,
              attachment.contentType,
              attachment.fileName
            )
          })
          .catch(() => {
            setFailed(true)
          })
          .finally(() => {
            setBusy(false)
          })
      }}
      style={styles.file}
    >
      {busy ? (
        <ActivityIndicator color={theme.secondaryTextColor} />
      ) : (
        <Icon name="description" color={theme.secondaryTextColor} />
      )}
      <View style={styles.fileText}>
        <Text style={styles.name} numberOfLines={1}>
          {attachment.fileName}
        </Text>
        <Text style={styles.size}>
          {failed
            ? lstrings.chat_attachment_failed
            : sizeLabel(attachment.size)}
        </Text>
      </View>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  picture: {
    borderRadius: theme.rem(theme.radiusRem),
    overflow: 'hidden',
    backgroundColor: theme.inactiveBackgroundColor,
    alignItems: 'center',
    justifyContent: 'center'
  },
  video: {
    gap: theme.rem(0.25),
    padding: theme.rem(theme.spaceSmRem)
  },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.inactiveBackgroundColor,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem)
  },
  fileText: {
    flexShrink: 1
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  size: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  failed: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.dangerColor,
    padding: theme.rem(theme.spaceSmRem)
  }
}))
