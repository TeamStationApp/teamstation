import React, { useEffect, useRef } from 'react'

import { useSceneShown } from '../components/sceneShown'
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
  // A screen pushed over the chat leaves no control in reach. It picks up as
  // it stood: a video the person had paused stays paused.
  const shown = useSceneShown()
  const video = useRef<HTMLVideoElement>(null)
  const resume = useRef(false)
  useEffect(() => {
    const node = video.current
    if (node == null) return
    if (shown) {
      if (resume.current) node.play().catch(() => undefined)
      resume.current = false
    } else {
      resume.current = !node.paused
      node.pause()
    }
  }, [shown])
  return (
    <video
      ref={video}
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
