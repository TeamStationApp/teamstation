import React, { useCallback, useEffect, useRef, useState } from 'react'
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native'

import type { BoardStep, TeamStationClient } from '../../../common/api'
import { SCOREBOARD_BOARD_SIZE } from '../../../common/scoreboard'
import type { WallTimeline } from '../../../common/wallTimeline'
import { ScoreboardBoard } from '../../scoreboard/ScoreboardBoard'
import type { Rect } from '../controlGeometry'
import type { VideoHandle } from '../videoHandle'
import { stepsInFrame, zeroedStep } from './boardAt'
import { keptBoard } from './keptBoard'
import { singleBoardRect, type Size } from './overlayLayout'
import { useBoardTimeline } from './useBoardTimeline'
import { usePlayheadStep } from './usePlayheadStep'
import { useScoreboardOverlay } from './useScoreboardOverlay'
import { useWallTimeline } from './useWallTimeline'
import { timeFrame, wallAt, windowStart } from './wallTimeline'

export interface ScoreboardOverlayProps {
  /** The board to draw; nothing at all while there is none. */
  step: BoardStep | null
  /**
   * Where the board goes, given the size it measured at: the rectangle it is
   * scaled into, or null to keep it off the picture.
   */
  place: (natural: Size) => Rect | null
  /** Its natural size, each time it is measured. */
  onNaturalSize?: (natural: Size) => void
  /** Where it is drawn, each time that changes; null while it is not. */
  onRect?: (rect: Rect | null) => void
}

/**
 * The game's scoreboard over a video, as the board OBS and TS Director draw
 * (`ScoreboardBoard`).
 *
 * Drawn at its own size and measured, then scaled by one factor so its height
 * is the height it was given; its width follows, so long team names make it
 * wider rather than squeezing them. It catches no touches: every tap goes to
 * whatever is under it. Until it has measured itself, and wherever `place`
 * has no room for it, it is drawn invisibly, so that it can measure.
 *
 * Hidden by design: there is no setting for it and nothing in the app names
 * it. `scoreboard-overlay` and `data-at`, the step's time in ms, are for the
 * tests.
 */
export function ScoreboardOverlay(
  props: ScoreboardOverlayProps
): React.ReactElement | null {
  const { step, place, onNaturalSize, onRect } = props
  const [natural, setNatural] = useState<Size | null>(null)
  const measured = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout
      if (width <= 0 || height <= 0) return
      setNatural(current =>
        current?.width === width && current.height === height
          ? current
          : { width, height }
      )
      onNaturalSize?.({ width, height })
    },
    [onNaturalSize]
  )
  const rect = step == null || natural == null ? null : place(natural)
  // Said after the render that drew it there, and only when it moved.
  const told = useRef<string | null>(null)
  const key = rect == null ? 'none' : `${rect.x},${rect.y},${rect.w},${rect.h}`
  useEffect(() => {
    if (told.current === key) return
    told.current = key
    onRect?.(rect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onRect])
  if (step == null) return null

  const scale = natural == null || rect == null ? 1 : rect.h / natural.height
  const shown = natural != null && rect != null
  return (
    <View
      testID={shown ? 'scoreboard-overlay' : undefined}
      dataSet={shown ? { at: String(step.at) } : undefined}
      pointerEvents="none"
      style={[
        styles.box,
        shown
          ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
          : styles.hidden
      ]}
    >
      <View style={styles.room}>
        <View
          onLayout={measured}
          style={
            shown
              ? {
                  // Scaled about its top-left corner: a transform scales
                  // about the middle, so it is moved back by what that
                  // costs first.
                  transform: [
                    { translateX: (-natural.width * (1 - scale)) / 2 },
                    { translateY: (-natural.height * (1 - scale)) / 2 },
                    { scale }
                  ]
                }
              : null
          }
        >
          <ScoreboardBoard
            state={step.state}
            minWidth={SCOREBOARD_BOARD_SIZE.width}
          />
        </View>
      </View>
    </View>
  )
}

export interface PictureScoreboardProps {
  client: TeamStationClient
  /** The game the video is of; no game, no board. */
  gameId: string | null | undefined
  videoId: string
  live: boolean
  /** The video's length as the server has it; null while unknown or live. */
  durationSec: number | null
  /** The picture inside the player view, less any black bars. */
  picture: Rect
  videoRef: React.RefObject<VideoHandle | null>
  /** Told the video's wall timeline each time it changes, for the player. */
  onTimeline?: (timeline: WallTimeline | null) => void
  /**
   * Told where the board is drawn, in the picture's view, each time that
   * changes, or null while none is: the card's controls keep clear of it.
   */
  onPlaced?: (rect: Rect | null) => void
}

/**
 * The board over the single player: the game's board at the wall time of the
 * frame on screen, where the node's single-camera setting puts it on the
 * picture (`singleBoardRect`), for a game on or after the overlay's start
 * date; nothing for one before it, or while the server has not said.
 *
 * A video with any of the game's events in its time frame shows the board
 * from its first frame: before the first event, the team names and nothing
 * else (`zeroedStep`). A video with none of them shows no board.
 *
 * Once a game's board has shown, it stays (`keptBoard`): through another
 * video or angle, a seek, a reload and anything loading, it never blinks out.
 */
export function PictureScoreboard(
  props: PictureScoreboardProps
): React.ReactElement | null {
  const { client, gameId, videoId, live, durationSec, picture, videoRef } =
    props
  const overlay = useScoreboardOverlay(client, gameId, videoId)
  const timeline = useWallTimeline(client, videoId, live)
  const { onTimeline } = props
  useEffect(() => {
    onTimeline?.(timeline)
  }, [onTimeline, timeline])
  const wallNow = (): number | null => {
    const video = videoRef.current
    if (video == null || timeline == null) return null
    return wallAt(timeline.anchors, video.currentTime * 1000)
  }
  const board = useBoardTimeline({
    client,
    gameId: overlay?.show === true ? gameId : null,
    fromMs: windowStart(timeline),
    live: live || timeline?.live === true,
    playheadWall: wallNow
  })
  const step = usePlayheadStep({
    steps: board.steps,
    wallNow,
    onSeek: board.refetchAround
  })
  let framed: BoardStep | null = null
  if (overlay?.show === true && board.steps != null && timeline != null) {
    const frame = timeFrame([{ live, timeline, durationSec }])
    if (frame != null && stepsInFrame(board.steps, frame.fromMs, frame.toMs))
      framed = step ?? zeroedStep(board.steps, frame.fromMs)
  }
  const { onPlaced } = props
  const shown = keptBoard({
    client,
    gameId,
    hidden: overlay?.show === false,
    framed,
    step,
    steps: board.steps,
    wallMs: wallNow()
  })
  const none = shown == null || overlay == null
  // Nothing drawn: no board to keep clear of. Drawn, the overlay says where.
  useEffect(() => {
    if (none) onPlaced?.(null)
  }, [none, onPlaced])
  if (shown == null || overlay == null) return null
  return (
    <ScoreboardOverlay
      step={shown}
      place={natural =>
        singleBoardRect({ picture, placement: overlay.single, natural })
      }
      onRect={onPlaced}
    />
  )
}

/**
 * How wide the board may lay itself out before it is scaled. The board is as
 * wide as its team names, and laid out in anything narrower it wraps them
 * instead: so it is given far more room than it needs, sits at its start,
 * and the box it is drawn into cuts off the rest.
 */
const BOARD_ROOM = 4000

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 1,
    overflow: 'hidden'
  },
  hidden: { opacity: 0 },
  room: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: BOARD_ROOM,
    alignItems: 'flex-start'
  }
})
