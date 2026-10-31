import React, { useRef, useState } from 'react'
import { Platform, StyleSheet } from 'react-native'
import Video, { type VideoRef } from 'react-native-video'

/** A live duration alone does not identify the start of its DVR window. */
export function previewMidpoint(
  duration: number,
  live: boolean,
  window?: { start: number; end: number }
): number | null {
  if (live) {
    if (
      window === undefined ||
      !Number.isFinite(window.start) ||
      !Number.isFinite(window.end) ||
      window.start < 0 ||
      window.end <= window.start
    )
      return null
    return (window.start + window.end) / 2
  }
  return Number.isFinite(duration) && duration > 0 ? duration / 2 : null
}

/** Keep the poster visible until the initial seek has actually completed. */
export function MidpointPreview({
  uri,
  live,
  muted,
  testID,
  onError,
  onPosition
}: {
  uri: string
  live: boolean
  muted: boolean
  testID: string
  onError: () => void
  onPosition?: (seconds: number) => void
}): React.ReactElement {
  const ref = useRef<VideoRef>(null)
  const midpoint = useRef<number | null>(null)
  const [ready, setReady] = useState(false)
  const [position, setPosition] = useState(0)
  return (
    <Video
      ref={ref}
      testID={testID}
      accessibilityLabel="Video preview"
      accessibilityValue={{ text: `${position} seconds` }}
      source={{ uri }}
      style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]}
      resizeMode="cover"
      muted={muted}
      volume={Platform.OS === 'web' ? 60 : 0.6}
      paused={!ready}
      repeat={false}
      controls={false}
      playInBackground={false}
      playWhenInactive={false}
      onLoad={event => {
        // This player API supplies no absolute seekable start for live media.
        // Without both DVR bounds the preview stays a poster.
        const target = previewMidpoint(event.duration, live)
        midpoint.current = target
        if (target !== null) ref.current?.seek(target)
      }}
      onSeek={event => {
        if (
          midpoint.current !== null &&
          Math.abs(event.currentTime - midpoint.current) < 1
        ) {
          onPosition?.(Math.floor(event.currentTime))
          setPosition(Math.floor(event.currentTime))
          setReady(true)
        }
      }}
      onProgress={event => {
        if (ready) {
          onPosition?.(Math.floor(event.currentTime))
          setPosition(Math.floor(event.currentTime))
        }
      }}
      onEnd={() => {
        setReady(false)
        if (midpoint.current !== null) ref.current?.seek(midpoint.current)
      }}
      onError={onError}
    />
  )
}
