import React, { useEffect, useRef } from 'react'
import { Platform, View } from 'react-native'
import Video, { type VideoRef, ViewType } from 'react-native-video'

import type { GameSponsorReel } from '../../../common/sponsors/types'
import { animationFrames } from '../scoreboardOverlay/usePlayheadStep'
import { REEL_DRIFT_SEC, type SponsorReelProps } from './sponsorReelProps'
import { useReelNow } from './useReelNow'

export { REEL_DRIFT_SEC, type SponsorReelProps } from './sponsorReelProps'

/**
 * A game's sponsor reel on a phone or the TV: `react-native-video` at
 * `rect` while the game's clock is inside one of `reels`, nothing
 * otherwise. As in a browser it plays on the game's clock: each display
 * frame its position, carried forward from the player's last report, is put
 * back to how far into the reel the picture is when the two are more than
 * `REEL_DRIFT_SEC` apart. It takes no touch.
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
      pointerEvents="none"
      style={{
        position: 'absolute',
        zIndex,
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
  frames: NonNullable<SponsorReelProps['frames']>
}): React.ReactElement {
  const { reel, frames, wallNow, muted, paused } = props
  const player = useRef<VideoRef | null>(null)
  const latest = useRef({ wallNow, paused })
  latest.current = { wallNow, paused }
  /** Where the player was last known to be, and when (ms). */
  const known = useRef<{ sec: number; at: number } | null>(null)
  const loaded = useRef(false)

  const seek = (sec: number): void => {
    player.current?.seek(sec)
    known.current = { sec, at: Date.now() }
  }

  useEffect(() => {
    let handle = 0
    const tick = (): void => {
      const wall = latest.current.wallNow()
      if (loaded.current && wall != null) {
        const offset = Math.max(0, (wall - reel.startMs) / 1000)
        const last = known.current
        const at =
          last == null
            ? null
            : last.sec +
              (latest.current.paused ? 0 : (Date.now() - last.at) / 1000)
        if (at == null || Math.abs(at - offset) > REEL_DRIFT_SEC) seek(offset)
      }
      handle = frames.request(tick)
    }
    tick()
    return () => {
      frames.cancel(handle)
    }
  }, [reel, frames])

  return (
    <Video
      ref={player}
      source={{ uri: reel.url }}
      paused={paused}
      muted={muted}
      volume={1}
      resizeMode="contain"
      // The game's audio session is the player's; the reel only joins it.
      disableFocus
      ignoreSilentSwitch="ignore"
      mixWithOthers="mix"
      progressUpdateInterval={250}
      // A SurfaceView draws under the cameras' TextureViews on Android, out
      // of sight; a TextureView is drawn in the views' own order, on top.
      viewType={Platform.OS === 'android' ? ViewType.TEXTURE : undefined}
      onLoad={() => {
        loaded.current = true
        const wall = latest.current.wallNow()
        if (wall != null) seek(Math.max(0, (wall - reel.startMs) / 1000))
      }}
      onProgress={event => {
        known.current = { sec: event.currentTime, at: Date.now() }
      }}
      style={{ width: '100%', height: '100%' }}
    />
  )
}
