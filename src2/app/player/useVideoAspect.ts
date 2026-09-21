import { type RefObject, useEffect, useState } from 'react'

import type { VideoHandle } from './videoHandle'

/**
 * The shape of the file, rather than the shape we assumed.
 *
 * The player used to be a 16:9 box with the picture letterboxed inside it,
 * which paints black bars over the one thing the screen is for — and a
 * multi-angle recording of two cameras is not 16:9 at all. Ask the element what
 * it has, and give it a box that fits.
 */
export function useVideoAspect(
  ref: RefObject<VideoHandle | null>,
  videoId: string | undefined
): number {
  const [aspect, setAspect] = useState(16 / 9)

  useEffect(() => {
    const video = ref.current
    if (video == null) return
    // A new source until it says otherwise: keeping the last one would size the
    // box for the recording that just went away.
    setAspect(16 / 9)
    const read = (): void => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setAspect(video.videoWidth / video.videoHeight)
      }
    }
    read()
    video.addEventListener('loadedmetadata', read)
    // Fires when the stream switches to a different rendition mid-play.
    video.addEventListener('resize', read)
    return () => {
      video.removeEventListener('loadedmetadata', read)
      video.removeEventListener('resize', read)
    }
  }, [ref, videoId])

  return aspect
}
