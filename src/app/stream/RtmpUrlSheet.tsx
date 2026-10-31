import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type {
  CameraSource,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { copyToClipboard } from '../platform/clipboard'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { SheetModal } from './SheetModal'
import { StreamPill } from './StreamPill'

/** A camera to make as the sheet opens, or the one it opens on. */
export type RtmpTarget =
  { name: string; source: CameraSource } | { stream: LiveStream }

export interface RtmpUrlSheetProps {
  visible: boolean
  client: TeamStationClient
  gameId: string
  target: RtmpTarget
  /** Done, or the backdrop. The camera stays. */
  onClose: () => void
  onRevoke: (stream: LiveStream) => void
  /** A camera was made, whether or not the sheet is still up. */
  onCreated?: () => void
  onDismiss?: () => void
  /** The clipboard; a test hands in its own. */
  copy?: (text: string) => void
}

/** The camera, with its URL. */
async function cameraOf(
  client: TeamStationClient,
  gameId: string,
  target: RtmpTarget,
  onCreated?: () => void
): Promise<LiveStream> {
  let stream: LiveStream
  if ('stream' in target) stream = target.stream
  else {
    stream = await client.addLiveStream(gameId, target.name, {
      source: target.source
    })
    onCreated?.()
  }
  return stream.url != null
    ? stream
    : await client.revealLiveStream(gameId, stream.id)
}

/**
 * "Stream using RTMP": the URL to enter into the camera. The camera is made
 * when this opens, and it is tied to the account, so any device signed in to
 * it can open this again.
 */
export function RtmpUrlSheet(props: RtmpUrlSheetProps): React.ReactElement {
  const {
    visible,
    client,
    gameId,
    target,
    onClose,
    onRevoke,
    onCreated,
    onDismiss,
    copy = copyToClipboard
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [stream, setStream] = useState<LiveStream | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const asked = useRef(false)
  const ask = useRef({ client, gameId, target, onCreated })

  useEffect(() => {
    if (!visible || asked.current) return
    asked.current = true
    const now = ask.current
    cameraOf(now.client, now.gameId, now.target, now.onCreated).then(
      setStream,
      (caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : lstrings.common_retry
        )
      }
    )
  }, [visible])

  const url = stream?.url
  return (
    <SheetModal
      visible={visible}
      title={lstrings.stream_rtmp_title}
      onClose={onClose}
      onDismiss={onDismiss}
      testID="rtmp-url-sheet"
    >
      <Text style={styles.note}>{lstrings.stream_rtmp_use_url}</Text>
      <View style={styles.urlBox}>
        {url == null && error == null && <ActivityIndicator />}
        {url != null && (
          <>
            <Text selectable style={styles.url} testID="rtmp-url">
              {url}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.stream_action_copy}
              testID="rtmp-copy"
              style={styles.copy}
              onPress={() => {
                copy(url)
                setCopied(true)
              }}
            >
              <Icon name="content_copy" color={theme.linkTextColor} />
            </Pressable>
          </>
        )}
        {error != null && <Text style={styles.error}>{error}</Text>}
      </View>
      {copied && (
        <Text style={styles.copied} testID="rtmp-copied">
          {lstrings.stream_rtmp_copied}
        </Text>
      )}
      <Text style={styles.note}>{lstrings.stream_rtmp_key_blank}</Text>
      <Text style={styles.note}>{lstrings.stream_rtmp_hevc}</Text>
      <Text style={styles.note}>{lstrings.stream_rtmp_return}</Text>
      <View style={styles.actions}>
        {stream != null && (
          <Button
            kind="text"
            label={lstrings.stream_rtmp_revoke}
            textColor={theme.dangerColor}
            testID="rtmp-revoke"
            onPress={() => {
              onRevoke(stream)
            }}
          />
        )}
        <StreamPill
          label={lstrings.stream_rtmp_done}
          testID="rtmp-done"
          onPress={onClose}
        />
      </View>
    </SheetModal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  urlBox: {
    minHeight: theme.rem(3.5),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingLeft: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceXsRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.containerBackgroundColor
  },
  url: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.primaryTextColor
  },
  copy: {
    minWidth: theme.rem(3),
    minHeight: theme.rem(3),
    alignItems: 'center',
    justifyContent: 'center'
  },
  copied: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  error: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  },
  // Pushed to the foot of the sheet.
  actions: {
    marginTop: 'auto',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  }
}))
