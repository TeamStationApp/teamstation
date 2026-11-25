import React, { useEffect, useRef } from 'react'
import { View } from 'react-native'

import type { GameSponsorReel } from '../../../common/sponsors/types'
import {
  animationFrames,
  type FrameLoop
} from '../scoreboardOverlay/usePlayheadStep'
import { REEL_DRIFT_SEC, type SponsorReelProps } from './sponsorReelProps'
import { useReelNow } from './useReelNow'

export { REEL_DRIFT_SEC, type SponsorReelProps } from './sponsorReelProps'

/**
 * A game's sponsor reel, in a browser: a `<video>` at `rect` while the
 * game's clock is inside one of `reels` (`useReelNow`), nothing otherwise.
 * It plays on the game's clock, not its own: each display frame it is put
 * back to how far into the reel the picture is when it has drifted more than
 * `REEL_DRIFT_SEC` from it, so joining or seeking into a reel starts it at
 * the right place, and every angle and every later playback see the same
 * frame of it at the same moment. It takes no touch.
 */
export function SponsorReel(
  props: SponsorReelProps
): React.ReactElement | null {
  const {
    reels,
    wallNow,
    rect,
    muted,
    paused,
    frames = animationFrames,
    zIndex = 3
  } = props
  const reel = useReelNow({ reels, wallNow, frames })
  if (reel == null || rect == null || !(rect.w > 0 && rect.h > 0)) return null
  return (
    <View
      testID="sponsor-reel"
      style={{
        position: 'absolute',
        zIndex,
        pointerEvents: 'none',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        backgroundColor: '#000'
      }}
    >
      <ReelVideo
        key={reel.id}
        reel={reel}
        wallNow={wallNow}
        muted={muted}
        paused={paused}
        frames={frames}
      />
    </View>
  )
}

function ReelVideo(props: {
  reel: GameSponsorReel
  wallNow: () => number | null
  muted: boolean
  paused: boolean
  frames: FrameLoop
}): React.ReactElement {
  const { reel, frames, wallNow, muted, paused } = props
  const element = useRef<HTMLVideoElement | null>(null)
  const latest = useRef({ wallNow, muted, paused })
  latest.current = { wallNow, muted, paused }

  useEffect(() => {
    let handle = 0
    const tick = (): void => {
      const video = element.current
      const { wallNow, paused, muted } = latest.current
      const wall = wallNow()
      if (video != null) {
        if (video.muted !== muted) video.muted = muted
        if (wall != null) {
          const offset = Math.max(0, (wall - reel.startMs) / 1000)
          if (
            video.readyState >= 1 &&
            Math.abs(video.currentTime - offset) > REEL_DRIFT_SEC
          )
            video.currentTime = offset
        }
        if (paused && !video.paused) video.pause()
        else if (!paused && video.paused && !video.ended)
          video.play()?.catch(() => undefined)
      }
      handle = frames.request(tick)
    }
    tick()
    return () => {
      frames.cancel(handle)
    }
  }, [reel, frames])

  return (
    <video
      ref={element}
      src={reel.url}
      data-reel={reel.id}
      muted={muted}
      playsInline
      preload="auto"
      onLoadedMetadata={() => {
        // At once on load, not a frame later: the first frame is the right one.
        const video = element.current
        const wall = latest.current.wallNow()
        if (video != null && wall != null)
          video.currentTime = Math.max(0, (wall - reel.startMs) / 1000)
      }}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  )
}
