import type { ScoreboardOverlay } from '../../common/nodeSettings'
import { SCOREBOARD_BOARD_SIZE } from '../../common/scoreboard'
import { playerLayout } from '../player/multiCam/playerLayout'
import { lineBoxHeight } from '../player/scoreboardOverlay/lineScoreLayout'
import { FULL_BOARD_HEIGHT } from '../player/scoreboardOverlay/overlayLayout'
import type { PlaybackState } from './playbackState'

export function tvLayout(
  state: PlaybackState,
  screen: { width: number; height: number },
  settings: ScoreboardOverlay | null,
  hasBoard: boolean,
  hasLine: boolean,
  natural: { width: number; height: number } = SCOREBOARD_BOARD_SIZE
): ReturnType<typeof playerLayout> {
  const result = playerLayout({
    screen,
    safe: { x: 0, y: 0, w: screen.width, h: screen.height },
    count: state.visible.length,
    aspect: 16 / 9,
    landscape: true,
    settings:
      settings === null
        ? null
        : {
            ...settings,
            landscape: settings.tvLandscape ?? settings.landscape
          },
    board: hasBoard && settings?.show === true ? natural : null,
    // Keep the reserved quadrant even while statistics are loading.
    line: hasLine || state.visible.length === 3,
    zoomed: state.full === null ? null : state.visible.indexOf(state.full)
  })
  if (state.full !== null) return result
  const count = state.visible.length
  if (count === 2) {
    result.tiles = result.tiles.map(tile => ({
      ...tile,
      y: (screen.height - tile.h) / 2
    }))
    const bottom = result.tiles[0].y - 8
    const width = screen.width / 2 - 16
    const fullHeight = Math.min(lineBoxHeight(width) * 0.75, bottom - 8)
    if (result.box !== null)
      result.box = { x: 8, y: bottom - fullHeight, w: width, h: fullHeight }
    if (result.board !== null) {
      const scale = Math.min(
        fullHeight / FULL_BOARD_HEIGHT,
        width / natural.width
      )
      result.board = {
        x: screen.width / 2 + 8,
        y: bottom - fullHeight,
        w: natural.width * scale,
        h: natural.height * scale
      }
    }
  } else if (count === 3) {
    const width = screen.width / 2
    const fullHeight = (FULL_BOARD_HEIGHT * width) / natural.width
    if (result.board !== null)
      result.board = {
        x: 0,
        y: 0,
        w: width,
        h: (natural.height * width) / natural.width
      }
    if (result.box !== null)
      result.box = {
        x: 0,
        y: result.board === null ? 0 : fullHeight + 5,
        w: width,
        h: Math.min(
          lineBoxHeight(width),
          screen.height / 2 - (result.board === null ? 0 : fullHeight + 5)
        )
      }
  }
  return result
}

export type Direction = 'left' | 'right' | 'up' | 'down'

/** A move reaches one neighboring picture or crosses one screen boundary. */
export function angleNeighbor(
  state: PlaybackState,
  index: number,
  direction: Direction
): number | null {
  if (state.full !== null) return null
  const tiles = tvLayout(
    state,
    { width: 1600, height: 900 },
    null,
    false,
    true
  ).tiles
  const slot = state.visible.indexOf(index)
  const from = tiles[slot]
  if (from === undefined) return null
  const horizontal = direction === 'left' || direction === 'right'
  const sign = direction === 'left' || direction === 'up' ? -1 : 1
  const center = horizontal ? from.x + from.w / 2 : from.y + from.h / 2
  const cross = horizontal ? from.y + from.h / 2 : from.x + from.w / 2
  const candidates = tiles.flatMap((tile, i) => {
    const delta =
      ((horizontal ? tile.x + tile.w / 2 : tile.y + tile.h / 2) - center) * sign
    const start = horizontal ? tile.y : tile.x
    const end = start + (horizontal ? tile.h : tile.w)
    return i !== slot && delta > 1 && cross >= start && cross <= end
      ? [{ index: state.visible[i], delta }]
      : []
  })
  candidates.sort((a, b) => a.delta - b.delta)
  return candidates[0]?.index ?? null
}
