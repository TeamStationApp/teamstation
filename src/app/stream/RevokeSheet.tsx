import React, { useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface RevokeSheetProps {
  visible: boolean
  client: TeamStationClient
  gameId: string
  stream: LiveStream
  onCancel: () => void
  /** The URL is dead and the camera over, or gone. */
  onRevoked: () => void
  onDismiss?: () => void
}

/** The confirmation before Revoke, with the angle's name in bold. */
export function RevokeSheet(props: RevokeSheetProps): React.ReactElement {
  const { visible, client, gameId, stream, onCancel, onRevoked, onDismiss } =
    props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [before, after] = lstrings.stream_revoke_body.split('%s')

  const confirm = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    // The server decides whether the camera goes: what the list last said of
    // it can be a moment old.
    client.revokeLiveStream(gameId, stream.id).then(
      () => {
        setBusy(false)
        onRevoked()
      },
      (caught: unknown) => {
        setBusy(false)
        setError(
          caught instanceof Error ? caught.message : lstrings.common_retry
        )
      }
    )
  }

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onCancel}
      onDismiss={onDismiss}
    >
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel={lstrings.stream_prompt_cancel}
          style={styles.behind}
          onPress={onCancel}
        />
        <View
          testID="revoke-sheet"
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, theme.rem(1.5)) }
          ]}
        >
          <Text style={styles.title}>{lstrings.stream_revoke_title}</Text>
          <Text style={styles.body}>
            {before}
            <Text style={styles.angle} testID="revoke-angle">
              {stream.label}
            </Text>
            {after}
          </Text>
          {error != null && <Text style={styles.error}>{error}</Text>}
          <Button
            label={lstrings.stream_rtmp_revoke}
            color={theme.dangerColor}
            textColor={theme.streamActionTextColor}
            busy={busy}
            testID="revoke-confirm"
            onPress={confirm}
          />
          <CancelAction
            destructivePrimary
            label={lstrings.stream_prompt_cancel}
            disabled={busy}
            onPress={onCancel}
          />
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    backgroundColor: theme.cardBackgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  angle: {
    fontFamily: theme.boldTextFont,
    fontWeight: '700'
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
