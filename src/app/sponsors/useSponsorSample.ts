import { useEffect, useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import {
  defaultSponsorSettings,
  type SponsorOverlay
} from '../../common/nodeSettings'
import type { Rect } from '../player/controlGeometry'
import type { SampleVideo } from './sponsorTypes'

export type SampleClient = Pick<TeamStationClient, 'sponsorSample'>

/** The sample read: loading, its answer, or a read that failed. */
export type SampleRead =
  | { kind: 'loading' }
  | { kind: 'ready'; sample: SampleVideo }
  | { kind: 'failed' }

/** The sentence for a sample that could not be read or played. */
export const SAMPLE_FAILED = 'The sample video could not be played.'

/** The video the league's previews play, from `client.sponsorSample`. */
export function useSponsorSample(
  client: SampleClient,
  leagueId: string
): SampleRead {
  const [read, setRead] = useState<SampleRead>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    setRead({ kind: 'loading' })
    client
      .sponsorSample(leagueId)
      .then(sample => {
        if (live) setRead({ kind: 'ready', sample })
      })
      .catch(() => {
        if (live) setRead({ kind: 'failed' })
      })
    return () => {
      live = false
    }
  }, [client, leagueId])
  return read
}

/** Where the previews place things: the node's settings, or the defaults. */
export function overlayOf(read: SampleRead): SponsorOverlay {
  return read.kind === 'ready' ? read.sample.overlay : defaultSponsorSettings
}

/**
 * Where to seek the sample at `time`: back to the window's start once it
 * reaches the end or is anywhere outside the window, else `null`.
 */
export function loopSeek(
  time: number,
  [start, end]: readonly [number, number]
): number | null {
  return time >= end || time < start ? start : null
}

/** The sample's frame, 16:9, in units the previews place their rects in. */
export const SAMPLE_FRAME: Rect = { x: 0, y: 0, w: 16, h: 9 }

/** A rect in `SAMPLE_FRAME` as fractions of the frame, for `OverlayAt`. */
export function boxOf(rect: Rect): {
  x: number
  y: number
  width: number
  height: number
} {
  return {
    x: rect.x / SAMPLE_FRAME.w,
    y: rect.y / SAMPLE_FRAME.h,
    width: rect.w / SAMPLE_FRAME.w,
    height: rect.h / SAMPLE_FRAME.h
  }
}
