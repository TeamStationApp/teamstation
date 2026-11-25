import React from 'react'
import { StyleSheet } from 'react-native'
import Video from 'react-native-video'

import type { SponsorReelPreviewProps } from './sponsorViewProps'

/**
 * A sponsor reel on a phone's reels screen, muted, looping and filling its
 * box; paused, it shows its first frame.
 */
export function SponsorReelPreview({
  url,
  label,
  playing
}: SponsorReelPreviewProps): React.ReactElement {
  return (
    <Video
      source={{ uri: url }}
      accessibilityLabel={label}
      muted
      repeat
      resizeMode="cover"
      paused={!playing}
      style={StyleSheet.absoluteFill}
    />
  )
}
