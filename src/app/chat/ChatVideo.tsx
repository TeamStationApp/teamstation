import React from 'react'

import { useTheme } from '../theme/ThemeContext'
import type { ChatVideoProps } from './chatVideoProps'

export type { ChatVideoProps }

/**
 * An opened video in a browser: a `<video>` on its Blob URL, with the
 * browser's own controls. The phones' twin plays a cache file through
 * `react-native-video`.
 */
export function ChatVideo(props: ChatVideoProps): React.ReactElement {
  const theme = useTheme()
  return (
    <video
      aria-label={props.label}
      src={props.uri}
      controls
      autoPlay
      playsInline
      style={{
        width: props.width,
        height: props.height,
        borderRadius: theme.rem(theme.radiusRem),
        backgroundColor: theme.videoBackgroundColor
      }}
    />
  )
}
