import React from 'react'
import { Text } from 'react-native'

import type { LiveStream } from '../../common/api'
import { ListCard } from '../components/ListCard'
import { ListRow } from '../components/ListRow'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { PhoneRecording } from './phoneStream'
import { SheetModal } from './SheetModal'

export interface VideoDetailsSheetProps {
  visible: boolean
  stream: LiveStream
  /** This phone's copy of the camera, when it holds one. */
  take: PhoneRecording | undefined
  /** That copy is on its way up already. */
  uploading: boolean
  onPlay: (videoId: string) => void
  onDeleteVideo: () => void
  onUpload: (take: PhoneRecording) => void
  onDeleteCopy: () => void
  onClose: () => void
  onDismiss?: () => void
}

/**
 * What can be done with one of the caller's own ended cameras. A device that
 * holds no copy of it is offered nothing to do with one.
 */
export function VideoDetailsSheet(
  props: VideoDetailsSheetProps
): React.ReactElement {
  const { visible, stream, take, uploading } = props
  const { onPlay, onDeleteVideo, onUpload, onDeleteCopy } = props
  const styles = getStyles(useTheme())
  const video = stream.playableVideoId
  return (
    <SheetModal
      visible={visible}
      title={lstrings.stream_details_title}
      cancelLabel={lstrings.stream_prompt_cancel}
      onClose={props.onClose}
      onDismiss={props.onDismiss}
      testID="video-details-sheet"
    >
      <Text style={styles.angle} testID="video-details-angle">
        {stream.label}
      </Text>
      <ListCard>
        {video != null && (
          <ListRow
            testID="video-details-play"
            title={lstrings.stream_details_play}
            onPress={() => {
              onPlay(video)
            }}
          />
        )}
        <ListRow
          testID="video-details-delete"
          title={lstrings.stream_details_delete}
          onPress={onDeleteVideo}
        />
        {take != null && take.uploadedAt == null && !uploading && (
          <ListRow
            testID="video-details-upload"
            title={lstrings.stream_details_upload}
            onPress={() => {
              onUpload(take)
            }}
          />
        )}
        {take != null && (
          <ListRow
            testID="video-details-delete-copy"
            title={lstrings.stream_details_delete_copy}
            onPress={onDeleteCopy}
          />
        )}
      </ListCard>
    </SheetModal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  angle: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.secondaryTextColor
  }
}))
