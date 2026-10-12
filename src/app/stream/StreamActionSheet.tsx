import React, { useEffect, useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { Button } from '../components/Button'
import {
  asksTwice,
  copyStreamUrl,
  runStreamAction,
  type StreamAction,
  streamActionsFor
} from '../components/streamActions'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The label of each action, read when drawn so a chosen language applies. */
function labelOf(action: StreamAction): string {
  switch (action) {
    case 'reveal':
      return lstrings.stream_action_copy
    case 'rotate':
      return lstrings.stream_action_rotate
    case 'end':
      return lstrings.stream_action_end
    case 'deleteVideo':
      return lstrings.stream_action_delete_video
    case 'remove':
      return lstrings.stream_action_remove
  }
}

export interface StreamActionSheetProps {
  client: TeamStationClient
  gameId: string
  stream: LiveStream
  /** The caller's own camera, rather than somebody else's they may end. */
  mine: boolean
  onClose: () => void
  /** After an action changed the camera, so the list is read again. */
  onChanged: () => void
  /** A word for the panel once the sheet has gone, such as "Copied". */
  onMessage: (text: string) => void
  /** The clipboard; a test hands in its own. */
  copy?: (text: string) => void
}

/**
 * The "…" on a camera in the phone's list: the web panel's actions on it,
 * offered and guarded by the same rules (`streamActions.ts`). Copy stream URL,
 * Rotate key, End, Delete recording and Remove on one's own camera; End on
 * somebody else's. Anything that would take a camera off the air asks for a
 * second tap while it is live, and deleting a recording always does.
 */
export function StreamActionSheet(
  props: StreamActionSheetProps
): React.ReactElement {
  const { client, gameId, stream, mine, onClose, onChanged, onMessage, copy } =
    props
  const styles = getStyles(useTheme())
  const [armed, setArmed] = useState<StreamAction | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // An armed action that is not pressed again goes back to being safe.
  useEffect(() => {
    if (armed == null) return
    const timer = setTimeout(() => {
      setArmed(undefined)
    }, 5000)
    return () => {
      clearTimeout(timer)
    }
  }, [armed])

  const press = (action: StreamAction): void => {
    if (busy) return
    if (asksTwice(action, stream) && armed !== action) {
      setArmed(action)
      return
    }
    setArmed(undefined)
    setBusy(true)
    setError(undefined)
    const work =
      action === 'reveal'
        ? copyStreamUrl(client, gameId, stream, copy).then(() => {
            onMessage(sprintf(lstrings.stream_action_copied, stream.label))
          })
        : runStreamAction(client, gameId, stream, action).then(() => {
            onChanged()
          })
    work.then(
      () => {
        setBusy(false)
        onClose()
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
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel={lstrings.stream_upload_cancel}
          style={styles.behind}
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <Text style={styles.title}>{stream.label}</Text>
          {streamActionsFor(stream, mine).map(action => {
            const label = labelOf(action)
            const shown =
              armed === action
                ? sprintf(lstrings.stream_action_again, label)
                : label
            return (
              <Pressable
                key={action}
                accessibilityRole="button"
                accessibilityLabel={shown}
                testID={`stream-action-${action}`}
                disabled={busy}
                onPress={() => {
                  press(action)
                }}
                style={({ pressed }) => [
                  styles.choice,
                  pressed && styles.pressed
                ]}
              >
                <Text
                  style={[
                    styles.label,
                    action !== 'reveal' && styles.destructive
                  ]}
                >
                  {shown}
                </Text>
              </Pressable>
            )
          })}
          {error != null && <Text style={styles.error}>{error}</Text>}
          <Button
            label={lstrings.stream_upload_cancel}
            kind="secondary"
            onPress={onClose}
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
    paddingBottom: theme.rem(2),
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  choice: {
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  destructive: { color: theme.dangerColor },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  },
  pressed: { opacity: 0.6 }
}))
