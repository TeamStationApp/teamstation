import React, { useCallback } from 'react'

import type { VideoViewProps } from './videoViewProps'

export type { VideoViewProps }

/**
 * The picture, and nothing else.
 *
 * A raw `<video>` is right here: react-native-web renders to the DOM, and the
 * browser's own player is what gives us hardware decoding for HEVC and H.264
 * alike, and a control bar that scrubs, mutes and goes fullscreen well. The
 * gesture layer above it is cut around those controls rather than replacing
 * them — see `controlGeometry.ts`.
 *
 * It fills its parent absolutely, which is what it did inline before: the
 * parent is either `PlayerSurface`'s box, sized to the video's own shape, or a
 * card's frame. Absolute so that everything drawn after it — the gesture
 * pieces, the scrim, the score — stacks above without needing a `zIndex`.
 */
export function VideoView(props: VideoViewProps): React.ReactElement {
  const {
    onHandle,
    controls = false,
    muted = false,
    resizeMode = 'contain',
    opacity = 1
  } = props

  const take = useCallback(
    (element: HTMLVideoElement | null): void => {
      // `HTMLVideoElement` satisfies `VideoHandle` without being told to,
      // which is the whole reason the interface has the shape it has.
      onHandle(element)
    },
    [onHandle]
  )

  return (
    <video
      ref={take}
      muted={muted}
      controls={controls}
      playsInline
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        objectFit: resizeMode,
        backgroundColor: '#000',
        opacity
      }}
    />
  )
}
