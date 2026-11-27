// The props of the sponsor views that have a phone twin, in a file of their
// own: a `.native` twin cannot import its web sibling's types, since on a
// phone that import resolves to the twin itself.
import type React from 'react'

import type { SponsorOverlay } from '../../common/nodeSettings'
import type { VideoHandle } from '../player/videoHandle'
import type { SampleClient } from './useSponsorSample'

export interface SponsorReelPreviewProps {
  url: string
  /** The video's accessible name. */
  label: string
  /** Playing and looping, or paused on the first frame. */
  playing: boolean
}

export interface SponsorSampleVideoProps {
  client: SampleClient
  leagueId: string
  /**
   * Previews drawn over the video, each placed in its own box; a function
   * is given where the node's settings put the logo and the reel.
   */
  children?: React.ReactNode | ((overlay: SponsorOverlay) => React.ReactNode)
  /** Points the element at a recording's playback URL; the player's own by default (web). */
  attach?: (handle: VideoHandle, url: string) => () => void
  /** Fills the box it is in, as beside a side panel (web; a phone always fills its column). */
  fill?: boolean
}

export interface SponsorDateTimeFieldProps {
  /** A local date-time, `YYYY-MM-DDTHH:mm`, or empty when none is chosen. */
  value: string
  onChange: (value: string) => void
}
