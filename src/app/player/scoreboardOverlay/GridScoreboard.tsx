import React, { useCallback, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import type { BoardStep, LineScoreStep } from '../../../common/api'
import type { ScoreboardOverlay as OverlaySettings } from '../../../common/nodeSettings'
import { SCOREBOARD_BOARD_SIZE } from '../../../common/scoreboard'
import { aspectOf, MAX_TILES, type Rect } from '../multiCam/layout'
import type { PlayerLayout } from '../multiCam/playerLayout'
import type { MultiCam, MultiCamProps } from '../multiCam/useMultiCam'
import { fromAnchors, type WallMapping } from '../wallMapping'
import { stepsInFrame, zeroedStep } from './boardAt'
import { keptBoard } from './keptBoard'
import { LineScoreBox } from './LineScoreBox'
import { type Size, tileNameTop } from './overlayLayout'
import { ScoreboardOverlay } from './ScoreboardOverlay'
import { useBoardTimeline } from './useBoardTimeline'
import { useLineScore } from './useLineScore'
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
  /** The board's natural size, as last measured (the full board's at first). */
  natural: Size
  /** The board for the master tile's frame, or null. */
  step: BoardStep | null
  /**
   * The game has a line score: it has events. Decided by the whole
   * timeline, not the playhead, so the layout never jumps as the box score
   * comes and goes.
   */
  hasLine: boolean
  /** The line score at the master tile's frame; null before the first step. */
  line: LineScoreStep | null
  /** The rows' names; null until the line score is in. */
  teams: { away: string; home: string } | null
  /** The board's natural size, each time it measures itself. */
  handleNaturalSize: (natural: Size) => void
  /**
   * Called with the grid on every render, once it exists: the board is read
   * at the wall time of its master tile's frame.
   */
  follow: (grid: GridClock) => void
  /**
   * An angle's mapping onto the wall clock from the server's wall timeline;
   * null without anchors, undefined until the timeline has been fetched.
   */
  mappingOf: (videoId: string) => WallMapping | null | undefined
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
  const timelinesRef = useRef(timelines)
  timelinesRef.current = timelines
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

  const live = angles.some(angle => angle.live)
  /** The box score's ask, for the board's change notices to make. */
  const refetchLines = useRef<() => void>(() => undefined)
  const fromMs = starts.length === 0 ? null : Math.min(...starts)
  const board = useBoardTimeline({
    client: props.client,
    gameId: shows ? props.gameId : null,
    fromMs,
    live,
    playheadWall: () => wall.current(),
    onChange: () => {
      refetchLines.current()
    }
  })
  /** The board watches the game's changes while it is up and live. */
  const boardWatches = live && shows && props.gameId != null && fromMs != null
  const step = usePlayheadStep({
    steps: board.steps,
    wallNow: () => wall.current(),
    onSeek: board.refetchAround
  })
  // The line score is the game's events', whatever the overlay's settings
  // or the board's log say.
  const lines = useLineScore({
    client: props.client,
    gameId: props.gameId,
    // Its own socket and poll only when the board's are not watching.
    live: live && !boardWatches
  })
  refetchLines.current = lines.refetch
  const line = usePlayheadStep({
    steps: lines.steps,
    wallNow: () => wall.current(),
    onSeek: lines.refetch
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
    natural,
    step: shown,
    hasLine: (lines.steps?.length ?? 0) > 0,
    line,
    teams: lines.teams,
    handleNaturalSize: measured,
    follow: mc => {
      grid.current = mc
    },
    mappingOf: id => {
      const timeline = timelinesRef.current[id]
      if (timeline == null) return undefined
      return timeline.anchors.length === 0
        ? null
        : fromAnchors(timeline.anchors)
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
 * Draws the grid's board and its box score where the player's layout puts
 * them (`playerLayout`): the board at the rect `layout` answers for the size
 * it measured, and the box score at the rect for the board's natural size,
 * so neither moves as the batter and pitcher rows come and go. Over the
 * top-left angle of four, sideways, the board is cut off by that angle. It
 * takes no touches.
 */
export function GridScoreboard(props: {
  board: GridBoard
  /** Where everything goes, for a board of the given natural size. */
  layout: (natural: Size) => PlayerLayout
}): React.ReactElement | null {
  const { board, layout } = props
  const placed = layout(board.natural)
  const boardShown = board.hasBoard && board.settings != null
  const box =
    board.hasLine && placed.box != null && board.teams != null ? (
      <View pointerEvents="none" style={styles.layer}>
        <LineScoreBox
          rect={placed.box}
          line={board.line?.line ?? null}
          teams={board.teams}
          at={board.line?.at ?? null}
        />
      </View>
    ) : null
  if (!boardShown) return box
  const clip = placed.boardClip
  const drawn = (
    <ScoreboardOverlay
      step={board.step}
      place={size => {
        const rect = layout(size).board
        if (rect == null || clip == null) return rect
        // In the clipping angle's own coordinates.
        return { ...rect, x: rect.x - clip.x, y: rect.y - clip.y }
      }}
      onNaturalSize={board.handleNaturalSize}
    />
  )
  return (
    <>
      {clip == null ? (
        <View pointerEvents="none" style={styles.layer}>
          {drawn}
        </View>
      ) : (
        <View
          pointerEvents="none"
          style={[
            styles.layer,
            styles.clip,
            { left: clip.x, top: clip.y, width: clip.w, height: clip.h }
          ]}
        >
          {drawn}
        </View>
      )}
      {box}
    </>
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
