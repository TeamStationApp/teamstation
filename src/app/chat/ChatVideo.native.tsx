import React from 'react'
import Video from 'react-native-video'

import { useTheme } from '../theme/ThemeContext'
import type { ChatVideoProps } from './chatVideoProps'

export type { ChatVideoProps }

/**
 * An opened video on a phone, played from the cache file it was decrypted
 * to, with the platform's own controls. The web's twin is a `<video>`.
 */
export function ChatVideo(props: ChatVideoProps): React.ReactElement {
  const theme = useTheme()
  return (
    <Video
      accessibilityLabel={props.label}
      source={{ uri: props.uri }}
      controls
      paused={false}
      resizeMode="contain"
      style={{
        width: props.width,
        height: props.height,
        borderRadius: theme.rem(theme.radiusRem),
        backgroundColor: theme.videoBackgroundColor
      }}
    />
  )
}
