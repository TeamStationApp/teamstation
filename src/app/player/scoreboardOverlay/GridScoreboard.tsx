import React, { useCallback, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import type { BoardStep } from '../../../common/api'
import type { ScoreboardOverlay as OverlaySettings } from '../../../common/nodeSettings'
import { SCOREBOARD_BOARD_SIZE } from '../../../common/scoreboard'
import { aspectOf, MAX_TILES, type Rect } from '../multiCam/layout'
import type { MultiCam, MultiCamProps } from '../multiCam/useMultiCam'
import { stepsInFrame, zeroedStep } from './boardAt'
import { keptBoard } from './keptBoard'
import {
  aboveBoardRect,
  bandBoardRect,
  bandHeight,
  cellBoardRect,
  keptClear,
  singleBoardRect,
  type Size,
  tileBoardRect,
  tileNameTop
} from './overlayLayout'
import { ScoreboardOverlay } from './ScoreboardOverlay'
import { useBoardTimeline } from './useBoardTimeline'
import { usePlayheadStep } from './usePlayheadStep'
import { useScoreboardOverlay } from './useScoreboardOverlay'
import { useWallTimelines } from './useWallTimeline'
import { angleWallMs, timeFrame, windowStart } from './wallTimeline'

/** What the grid's board reads its clock from, once the grid has one. */
export type GridClock = Pick<
  MultiCam,
  'masterId' | 'heardId' | 'chosen' | 'elementOf' | 'atWallMs'
>

export interface GridBoard {
  /**
   * There is a game on or after the overlay's start date with events in the
   * angles' time frame, or one whose board has shown already (`keptBoard`).
   */
  hasBoard: boolean
  /** The node's placement settings, once the server has said. */
  settings: OverlaySettings | null
  /** How many angles the grid shows. */
  count: number
  /** The angles' shared shape, as the grid lays them out. */
  aspect: number
  /**
   * Three angles sideways with a board: the angles leave it the top-left
   * quadrant. Handed to `useMultiCam` as its `boardCell`.
   */
  boardCell: boolean
  /**
   * The band across the top the tiles stay below: the board's, upright and
   * with a board; 0 otherwise. Handed to `useMultiCam` as its `top`.
   */
  band: number
  /** The board for the master tile's frame, or null. */
  step: BoardStep | null
  /** The board's natural size, each time it measures itself. */
  handleNaturalSize: (natural: Size) => void
  /**
   * Called with the grid on every render, once it exists: the board is read
   * at the wall time of its master tile's frame.
   */
  follow: (grid: GridClock) => void
  /**
   * Where a tile's name goes, in its own coordinates, while the board is
   * drawn over that tile (sideways), so it sits just below the full board;
   * undefined to leave it where every tile has it. The board is over the
   * top-left angle of four by the landscape setting, or over an angle that
   * fills the box (zoomed, or the only one) by the single setting.
   */
  nameTop: (
    index: number,
    rect: Rect | undefined,
    zoomed: number | null,
    /** The safe area the board is kept in, as `GridScoreboard` is given it. */
    safe?: Rect
  ) => number | undefined
}

/**
 * The game's board over the multi-angle grid, at the wall time of the master
 * tile's frame: one board for the grid, the same in a browser and on a phone.
 *
 * Its timelines are the angles' own. Upright it has a band above the stacked
 * angles, which the grid lays its tiles out below (`band`, before the grid is
 * made); sideways it goes over the top-left angle. The grid's clock is only
 * known once the grid exists, which needs the band first, so the grid is
 * handed back through `follow`.
 */
export function useGridBoard(
  props: Pick<MultiCamProps, 'client' | 'gameId' | 'order' | 'videos'>,
  /** The box the tiles are laid out in. */
  box: Size,
  landscape: boolean
): GridBoard {
  const angles = useMemo(
    () =>
      props.order
        .map(id => props.videos.find(video => video.id === id))
        .filter(video => video != null)
        .slice(0, MAX_TILES)
        .map(video => ({
          id: video.id,
          live: video.status === 'live',
          durationSec: video.durationSec,
          width: video.width,
          height: video.height
        })),
    [props.order, props.videos]
  )
  // Asked again whenever the angles change: a new set of videos loads.
  const settings = useScoreboardOverlay(
    props.client,
    props.gameId,
    // The set of videos, not their order: moving a tile loads nothing.
    angles
      .map(angle => angle.id)
      .sort()
      .join(',')
  )
  const shows = settings?.show === true
  const timelines = useWallTimelines(props.client, angles)
  const starts = angles
    .map(angle => windowStart(timelines[angle.id] ?? null))
    .filter(start => start != null)
  const grid = useRef<GridClock | null>(null)
  const masterWall = (): number | null => {
    const mc = grid.current
    if (mc == null) return null
    const id = mc.masterId ?? mc.heardId ?? mc.chosen[0]?.id
    const video = mc.chosen.find(one => one.id === id)
    const element = id == null ? undefined : mc.elementOf(id)
    if (video == null || element == null) return mc.atWallMs
    return angleWallMs(video, timelines[video.id], element.currentTime)
  }
  const wall = useRef(masterWall)
  wall.current = masterWall

  const board = useBoardTimeline({
    client: props.client,
    gameId: shows ? props.gameId : null,
    fromMs: starts.length === 0 ? null : Math.min(...starts),
    live: angles.some(angle => angle.live),
    playheadWall: () => wall.current()
  })
  const step = usePlayheadStep({
    steps: board.steps,
    wallNow: () => wall.current(),
    onSeek: board.refetchAround
  })
  const [natural, setNatural] = useState<Size>(SCOREBOARD_BOARD_SIZE)
  const measured = useCallback((size: Size) => {
    setNatural(current =>
      current.width === size.width && current.height === size.height
        ? current
        : size
    )
  }, [])
  // The angles' time frames together (`timeFrame`), by the server's lengths,
  // so the frame does not wait on, or change with, what the player has
  // loaded. A frame with any of the game's events in it shows the board from
  // its first frame; before the first event, the team names and nothing
  // else.
  const frame = timeFrame(
    angles.map(angle => ({
      live: angle.live,
      timeline: timelines[angle.id],
      durationSec: angle.durationSec
    }))
  )
  const framed =
    shows &&
    props.gameId != null &&
    board.steps != null &&
    frame != null &&
    stepsInFrame(board.steps, frame.fromMs, frame.toMs)
      ? (step ?? zeroedStep(board.steps, frame.fromMs))
      : null
  const shown = keptBoard({
    client: props.client,
    gameId: props.gameId,
    hidden: settings?.show === false,
    framed,
    step,
    steps: board.steps,
    wallMs: wall.current()
  })
  const hasBoard = shown != null && settings != null
  const count = angles.length
  // As the grid lays its tiles out (`useMultiCam`).
  const aspect = aspectOf(angles)
  return {
    hasBoard,
    settings,
    count,
    aspect,
    boardCell: hasBoard && landscape && count === 3,
    band:
      hasBoard && !landscape && settings != null
        ? bandHeight(box, natural, count, settings.portraitHeight, aspect)
        : 0,
    step: shown,
    handleNaturalSize: measured,
    follow: mc => {
      grid.current = mc
    },
    nameTop: (index, rect, zoomed, safe) => {
      if (!landscape || !hasBoard || settings == null || rect == null)
        return undefined
      // As `GridScoreboard` places the board.
      const filling = zoomed ?? (count === 1 ? 0 : null)
      if (filling != null)
        return index === filling
          ? tileNameTop(rect, settings.single, safe, natural)
          : undefined
      return count >= 4 && index === 0
        ? tileNameTop(rect, settings.landscape, safe, natural)
        : undefined
    }
  }
}

/**
 * Draws the grid's board in the box the tiles are laid out in. Upright, in
 * the band above the topmost angle. Sideways, by how many angles there are:
 * two, centred in the space above them; three, in the top-left quadrant they
 * leave it; four, over the top-left angle where the node's landscape setting
 * puts it, cut off by that angle. Sideways with one angle filling the box,
 * zoomed or the only one, that angle is a single picture, and the board sits
 * on it where the single-camera setting puts it. It takes no touches.
 */
export function GridScoreboard(props: {
  board: GridBoard
  box: Size
  landscape: boolean
  /** The angles' rectangles, in reading order. */
  rects: Rect[]
  /** The angle zoomed to the whole box, by its index in `rects`, or null. */
  zoomed?: number | null
  /**
   * The part of the box the hardware leaves, when the pictures run under a
   * notch or the rounded corners: the board is kept inside it.
   */
  safe?: Rect
}): React.ReactElement | null {
  const { board, box, landscape, rects } = props
  const { safe } = props
  const { settings, count } = board
  if (!board.hasBoard || settings == null) return null
  // Kept clear of the hardware, and still inside the area it was placed in.
  const clear = (rect: Rect | null, area: Rect): Rect | null =>
    rect == null || safe == null ? rect : keptClear(rect, safe, area)
  const whole = { x: 0, y: 0, w: box.width, h: box.height }
  const layer = (
    place: (size: Size) => Rect | null,
    area: Rect = whole
  ): React.ReactElement => (
    <View pointerEvents="none" style={styles.layer}>
      <ScoreboardOverlay
        step={board.step}
        place={size => clear(place(size), area)}
        onNaturalSize={board.handleNaturalSize}
      />
    </View>
  )
  if (!landscape)
    return layer(size =>
      bandBoardRect(box, size, count, settings.portraitHeight, board.aspect)
    )
  // One angle filling the box is a single picture: zoomed, or alone.
  const zoomed =
    props.zoomed != null
      ? rects[props.zoomed]
      : count === 1
        ? rects[0]
        : undefined
  if (zoomed != null)
    return layer(
      size =>
        singleBoardRect({
          picture: zoomed,
          placement: settings.single,
          natural: size
        }),
      zoomed
    )
  if (count === 2 && rects.length === 2)
    return layer(size =>
      aboveBoardRect(box, Math.min(rects[0].y, rects[1].y), size)
    )
  if (count === 3 && rects.length === 3) {
    // The quadrant the three leave: left of the top-right angle, above the
    // bottom-left one.
    const cell = { x: rects[1].x, y: rects[0].y, w: rects[1].w, h: rects[0].h }
    return layer(size => cellBoardRect(cell, size), cell)
  }
  const corner = rects[0]
  if (corner == null) return null
  return (
    <View
      pointerEvents="none"
      style={[
        styles.layer,
        styles.clip,
        { left: corner.x, top: corner.y, width: corner.w, height: corner.h }
      ]}
    >
      <ScoreboardOverlay
        step={board.step}
        place={size => {
          // In the angle's own coordinates, kept clear in the box's.
          const rect = tileBoardRect(corner, settings.landscape, size)
          if (rect == null || safe == null) return rect
          const kept = keptClear(
            { ...rect, x: corner.x + rect.x, y: corner.y + rect.y },
            safe,
            corner
          )
          return { ...kept, x: kept.x - corner.x, y: kept.y - corner.y }
        }}
        onNaturalSize={board.handleNaturalSize}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  // Above the tiles, which stack at 1 and 2, and below the words at 6.
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 3
  },
  clip: {
    right: undefined,
    bottom: undefined,
    overflow: 'hidden'
  }
})
