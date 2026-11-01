import React, { forwardRef, useLayoutEffect, useRef } from 'react'
import Video, { type VideoRef } from 'react-native-video'

/** The native rate setter briefly resumes AVPlayer when leaving a slow rate.
 * Keep its committed rate unchanged while paused, then apply the requested
 * transport rate when playback resumes. Each hidden camera keeps its own latch.
 */
export const TransportVideo = forwardRef<
  VideoRef,
  React.ComponentProps<typeof Video>
>(function TransportVideo(props, ref): React.ReactElement {
  const committedRate = useRef(1)
  const rate = props.paused === true ? committedRate.current : props.rate ?? 1
  useLayoutEffect(() => {
    committedRate.current = rate
  }, [rate])
  return <Video {...props} rate={rate} ref={ref} />
})
