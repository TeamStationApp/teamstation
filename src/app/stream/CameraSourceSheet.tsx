import React from 'react'
import { Text } from 'react-native'

import type { CameraSource } from '../../common/api'
import { ListCard } from '../components/ListCard'
import { ListRow } from '../components/ListRow'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CameraLogo } from './CameraLogo'
import { SheetModal } from './SheetModal'

export interface CameraSourceSheetProps {
  visible: boolean
  onChoose: (source: CameraSource) => void
  onClose: () => void
  onDismiss?: () => void
  /** Why the last row chosen did not go anywhere. */
  error?: string
}

/** The rows, read when drawn so a chosen language applies. */
function sources(): Array<{
  source: CameraSource
  title: string
  subtitle?: string
}> {
  return [
    { source: 'gopro', title: lstrings.stream_source_gopro },
    { source: 'mevo', title: lstrings.stream_source_mevo },
    { source: 'mevoStudio', title: lstrings.stream_source_mevo_studio },
    {
      source: 'rtmp',
      title: lstrings.stream_source_other,
      subtitle: lstrings.stream_source_other_detail
    }
  ]
}

/** "Stream with your camera": which external camera films this angle. */
export function CameraSourceSheet(
  props: CameraSourceSheetProps
): React.ReactElement {
  const { visible, onChoose, onClose, onDismiss, error } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <SheetModal
      visible={visible}
      title={lstrings.stream_source_title}
      cancelLabel={lstrings.stream_prompt_cancel}
      onClose={onClose}
      onDismiss={onDismiss}
      testID="camera-source-sheet"
    >
      <ListCard>
        {sources().map(({ source, title, subtitle }) => (
          <ListRow
            key={source}
            testID={`camera-source-${source}`}
            leading={<CameraLogo source={source} />}
            title={title}
            subtitle={subtitle}
            onPress={() => {
              onChoose(source)
            }}
          />
        ))}
      </ListCard>
      {error != null && (
        <Text style={styles.error} testID="camera-source-error">
          {error}
        </Text>
      )}
    </SheetModal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
