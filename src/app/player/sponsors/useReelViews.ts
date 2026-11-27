import { useEffect, useRef, useState } from 'react'

import type { AnalyticsClient } from '../../../common/observability/analyticsClient'
import type { GameSponsorReel } from '../../../common/sponsors/types'
import { useAnalytics } from '../../observability/AnalyticsContext'
import {
  animationFrames,
  type FrameLoop
} from '../scoreboardOverlay/usePlayheadStep'
import type { SponsorReelProps } from './sponsorReelProps'

/** How long a play of a reel must have played to be a view. */
export const REEL_VIEW_MS = 5000

/**
 * The longest step of the game's clock between two display frames that is
 * still playing; a longer one, or one back, is a seek, and is not counted.
 */
const MAX_PLAYED_STEP_MS = 2000

/** How finely the played time is handed on: four times a second. */
const PLAYED_STEP_MS = 250

/** A reel on screen, and the game and league whose sponsorship it is. */
export interface ReelView {
  reel: GameSponsorReel
  gameId: string
  leagueId: string
  /** The player's live flag. */
  live: boolean
}

/**
 * Sends `sponsor_reel_viewed` once per play of a placement, when
 * `playingMs`, the time this play has actually played, reaches
 * `REEL_VIEW_MS`. A play starts when `view` turns to a placement and ends
 * when it turns to nothing or to another, so a pause holds the count where
 * it is, and every playback that passes five seconds is a view of its own.
 * `at` is the placement's start on the game's clock.
 */
export function useReelViews(
  analytics: AnalyticsClient | undefined,
  view: ReelView | null,
  playingMs: number
): void {
  const play = useRef<{ id: string | null; sent: boolean }>({
    id: null,
    sent: false
  })
  const id = view?.reel.id ?? null
  if (play.current.id !== id) play.current = { id, sent: false }
  useEffect(() => {
    if (view == null || analytics == null) return
    if (play.current.sent || playingMs < REEL_VIEW_MS) return
    play.current.sent = true
    analytics
      .emit('sponsor_reel_viewed', {
        rp: view.reel.id,
        rr: view.reel.reelId,
        gm: view.gameId,
        lg: view.leagueId,
        at: view.reel.startMs,
        lv: view.live
      })
      .catch(() => undefined)
  }, [analytics, view, playingMs])
}

/**
 * How long the reel `reelId` has played since it came on screen, in steps
 * of `PLAYED_STEP_MS`: the game's clock moving forward a display frame at a
 * time, while not `paused`. 0 for no reel, and again for each new one.
 */
export function useReelPlayedMs(
  reelId: string | null,
  wallNow: () => number | null,
  paused: boolean,
  frames: FrameLoop = animationFrames
): number {
  // Each time the reel comes on is a play of its own, counted from 0.
  const play = useRef({ id: null as string | null, number: 0 })
  if (play.current.id !== reelId)
    play.current = { id: reelId, number: play.current.number + 1 }
  const number = play.current.number
  const [played, setPlayed] = useState({ number: 0, ms: 0 })
  const latest = useRef({ wallNow, paused })
  latest.current = { wallNow, paused }
  useEffect(() => {
    if (reelId == null) return
    let total = 0
    let last: number | null = null
    let handle = 0
    const tick = (): void => {
      const { wallNow, paused } = latest.current
      const wall = wallNow()
      if (wall != null && last != null && !paused) {
        const step = wall - last
        if (step > 0 && step <= MAX_PLAYED_STEP_MS) {
          const before = Math.floor(total / PLAYED_STEP_MS)
          total += step
          const after = Math.floor(total / PLAYED_STEP_MS)
          if (after !== before)
            setPlayed({ number, ms: after * PLAYED_STEP_MS })
        }
      }
      last = wall
      handle = frames.request(tick)
    }
    tick()
    return () => {
      frames.cancel(handle)
    }
  }, [reelId, number, frames])
  return reelId != null && played.number === number ? played.ms : 0
}

/**
 * The views of a `SponsorReel`'s reel: `reel` is the one playing now, and
 * counts only while it is drawn (a `rect` with room) for a game whose
 * sponsoring league is known.
 */
export function useSponsorReelViews(
  props: SponsorReelProps,
  reel: GameSponsorReel | null
): void {
  const { rect, wallNow, paused, frames, game } = props
  const analytics = useAnalytics()
  const shown =
    reel != null && rect != null && rect.w > 0 && rect.h > 0 ? reel : null
  const playingMs = useReelPlayedMs(shown?.id ?? null, wallNow, paused, frames)
  const view =
    shown == null || game?.leagueId == null
      ? null
      : {
          reel: shown,
          gameId: game.id,
          leagueId: game.leagueId,
          live: game.live
        }
  useReelViews(analytics, view, playingMs)
}
