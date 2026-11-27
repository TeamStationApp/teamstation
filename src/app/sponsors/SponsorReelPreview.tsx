import React from 'react'

import type { SponsorReelPreviewProps } from './sponsorViewProps'

export type { SponsorReelPreviewProps }

/**
 * A sponsor reel on the reels screen, muted and filling its box: playing
 * in the scoreboard's place over the sample, or paused on its first frame
 * as the table's picture. The phones draw it with react-native-video
 * (SponsorReelPreview.native.tsx).
 */
export function SponsorReelPreview({
  url,
  label,
  playing
}: SponsorReelPreviewProps): React.ReactElement {
  return (
    <video
      src={url}
      aria-label={label}
      muted
      playsInline
      {...(playing ? { loop: true, autoPlay: true } : { preload: 'metadata' })}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    />
  )
}
