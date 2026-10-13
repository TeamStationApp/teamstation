import React from 'react'
import { Text, View } from 'react-native'

import { Button } from '../components/Button'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { IDLE_BLUE, WHITE } from './overlay/overlayTheme'
import type { PhoneRecording, UploadProgress } from './phoneStream'

/** Where one take's upload stands, as its row shows it. */
export type UploadRowState =
  | { kind: 'ready' }
  | {
      kind: 'running'
      /** 0 to 1. */
      fraction: number
      step: 'exporting' | 'uploading' | 'processing'
    }
  | { kind: 'failed'; message: string }
  | { kind: 'done' }

/**
 * A take's upload, from what the engine last said of it.
 *
 * - `cancelled`: the person pressed Cancel, and the take is back to its
 *   button whatever the engine's last word was (a cancelled upload ends in a
 *   `failed` event).
 * - A progress event wins over the catalog's row, which is only read again
 *   when an upload lands or fails, or the list is polled.
 * - An upload the catalog has open but that is not running in this process
 *   was cut off: it says so, and Retry carries on from the server's parts.
 */
export function uploadRowState(
  recording: PhoneRecording,
  progress: UploadProgress | undefined,
  cancelled = false
): UploadRowState {
  if (recording.uploadedAt != null) return { kind: 'done' }
  if (cancelled) return { kind: 'ready' }
  if (progress != null) {
    if (progress.state === 'uploaded') return { kind: 'done' }
    if (progress.state === 'failed')
      return {
        kind: 'failed',
        message: sprintf(
          lstrings.stream_upload_failed,
          progress.message ?? lstrings.common_retry
        )
      }
    return {
      kind: 'running',
      fraction: progress.fraction,
      step: progress.state
    }
  }
  if (recording.uploadRunning)
    return { kind: 'running', fraction: 0, step: 'uploading' }
  if (recording.hasPendingUpload)
    return { kind: 'failed', message: lstrings.stream_upload_interrupted }
  return { kind: 'ready' }
}

/** `42%`, never below 0 or above 100. */
export function percent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
}

const STEP_LABEL = {
  exporting: 'stream_upload_exporting',
  uploading: 'stream_upload_uploading',
  processing: 'stream_upload_processing'
} as const

export interface RecordingUploadRowProps {
  recording: PhoneRecording
  /** The angle's name now: the server's, after any rename, else the take's own. */
  name: string
  state: UploadRowState
  onUpload: () => void
  onCancel: () => void
}

/**
 * One take on this phone that TeamStation does not have yet: a blue Upload
 * Recording, which sends the phone's own copy to replace the live one; then
 * its progress with Cancel; and on a failure the reason with Retry, which
 * carries on where it stopped.
 */
export function RecordingUploadRow(
  props: RecordingUploadRowProps
): React.ReactElement | null {
  const { recording, name, state, onUpload, onCancel } = props
  const styles = getStyles(useTheme())
  if (state.kind === 'done') return null
  const id = recording.liveStreamId
  return (
    <View style={styles.row} testID={`upload-row-${id}`}>
      <Text style={styles.name}>{name}</Text>
      {state.kind === 'ready' && (
        <>
          <Button
            label={lstrings.stream_upload_button}
            color={IDLE_BLUE}
            textColor={WHITE}
            testID={`upload-recording-${id}`}
            onPress={onUpload}
          />
          <Text style={styles.caption}>{lstrings.stream_upload_caption}</Text>
        </>
      )}
      {state.kind === 'running' && (
        <View style={styles.progressLine}>
          <View style={styles.progressColumn}>
            <Text style={styles.caption} testID={`upload-progress-${id}`}>
              {`${lstrings[STEP_LABEL[state.step]]} ${percent(state.fraction)}`}
            </Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { width: percent(state.fraction) as `${number}%` }
                ]}
              />
            </View>
          </View>
          <Button
            label={lstrings.stream_upload_cancel}
            kind="text"
            compact
            testID={`upload-cancel-${id}`}
            onPress={onCancel}
          />
        </View>
      )}
      {state.kind === 'failed' && (
        <View style={styles.progressLine}>
          <Text style={[styles.caption, styles.error]}>{state.message}</Text>
          <Button
            label={lstrings.stream_upload_retry}
            kind="secondary"
            compact
            testID={`upload-retry-${id}`}
            onPress={onUpload}
          />
        </View>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceSmRem)
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  caption: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  error: {
    flex: 1,
    color: theme.dangerColor
  },
  progressLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  progressColumn: {
    flex: 1,
    gap: theme.rem(0.25)
  },
  track: {
    height: theme.rem(0.375),
    borderRadius: theme.rem(0.1875),
    backgroundColor: theme.inactiveBackgroundColor,
    overflow: 'hidden'
  },
  fill: {
    height: '100%',
    backgroundColor: IDLE_BLUE
  }
}))
