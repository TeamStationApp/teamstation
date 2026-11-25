import React, { useState } from 'react'
import { View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** From this column width the video sits at two-thirds, the side beside it. */
export const SIDE_BY_SIDE_FROM = 720

/**
 * The sample video and its side panel (Add Logo, Add Reel or the pending
 * Accept). In a column at least `SIDE_BY_SIDE_FROM` wide the video takes
 * two-thirds and the side the right third; narrower, they stack.
 */
export function SponsorPreviewLayout({
  video,
  side
}: {
  video: (fill: boolean) => React.ReactNode
  side: React.ReactNode
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [width, setWidth] = useState(0)
  const wide = width >= SIDE_BY_SIDE_FROM
  return (
    <View
      testID="sponsor-preview-layout"
      style={wide ? styles.row : styles.stack}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
    >
      <View style={wide ? styles.video : undefined}>{video(wide)}</View>
      <View style={wide ? styles.side : undefined}>{side}</View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  stack: { gap: theme.rem(1) },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.rem(1)
  },
  video: { width: '66.6667%' },
  side: { flex: 1, minWidth: 0, maxWidth: '33.3333%' }
}))
