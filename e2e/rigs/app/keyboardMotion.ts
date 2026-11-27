import { join } from 'node:path'

import type { GrayFrame } from '../../core/video'

/**
 * Whether something on a phone moved through the frames between two places
 * or jumped, read off maestro-d's recording of the device's own screen: a
 * horizontal edge (the top of Search's field) is followed down the
 * picture's centre column, frame by frame. The recording and the reading of
 * its frames are maestro-d's and the video layer's (`e2e/core/video.ts`);
 * this rig only follows the edge.
 */

/** One grayscale frame, row by row. */
export type Frame = GrayFrame

/**
 * Where an element at rest sits in the recording's picture: its top, in
 * the hierarchy's points, scaled from the screen's height in points to the
 * picture's in pixels.
 */
export function restRow(
  topPoints: number,
  screenPoints: number,
  picturePixels: number
): number {
  if (!(screenPoints > 0)) throw new Error('the screen has no height')
  const row = Math.round((topPoints * picturePixels) / screenPoints)
  return Math.min(Math.max(row, 1), picturePixels - 1)
}

/** The mean brightness of a row across the few columns at the centre. */
function rowLevel(frame: Frame, y: number, half = 3): number {
  const centre = Math.floor(frame.width / 2)
  let sum = 0
  for (let x = centre - half; x <= centre + half; x++)
    sum += frame.data[y * frame.width + x]
  return sum / (half * 2 + 1)
}

/**
 * The field's top edge in each frame: the strongest change in brightness
 * down the centre column within `reach` rows of where it was in the frame
 * before, starting from its place at rest. A camera frame is 30 a second,
 * and a keyboard's animation a quarter of a second, so an edge that moves
 * moves no more than a few dozen rows from one frame to the next.
 */
export function fieldTopPerFrame(
  all: Frame[],
  start: number,
  reach?: number
): number[] {
  const positions: number[] = []
  let last = start
  for (const frame of all) {
    // A keyboard crosses a third of a phone's height in a quarter second:
    // eight frames at 30 a second, so a frame's step is a twelfth of it.
    const near = reach ?? Math.max(60, Math.round(frame.height / 12))
    let best = last
    let strongest = -1
    const from = Math.max(1, last - near)
    const to = Math.min(frame.height - 1, last + near)
    for (let y = from; y <= to; y++) {
      const step = Math.abs(rowLevel(frame, y) - rowLevel(frame, y - 1))
      if (step > strongest) {
        strongest = step
        best = y
      }
    }
    positions.push(best)
    last = best
  }
  return positions
}

/** What one run of positions did between its two places. */
export interface Motion {
  rest: number
  raised: number
  /** The distinct places strictly between, with `tolerance` either side. */
  between: number[]
  animated: boolean
}

/**
 * Whether an edge moved from where it starts to the farthest place it
 * reaches and back, through at least `minimum` places between each way
 * (rather than one jump). `tolerance` absorbs the camera's own shimmer.
 */
export function motionOf(
  positions: number[],
  minimum = 3,
  tolerance = 2
): { up: Motion; down: Motion } {
  if (positions.length === 0) throw new Error('no frames to read')
  const rest = positions[0]
  const raised = positions.reduce((a, b) => (b < a ? b : a), rest)
  const peak = positions.indexOf(raised)
  const between = (run: number[]): number[] => [
    ...new Set(run.filter(y => y > raised + tolerance && y < rest - tolerance))
  ]
  const leg = (run: number[]): Motion => {
    const places = between(run)
    return { rest, raised, between: places, animated: places.length >= minimum }
  }
  return {
    up: leg(positions.slice(0, peak + 1)),
    down: leg(positions.slice(peak))
  }
}

/** The frames' file beside a run's other evidence. */
export function motionFile(runDir: string, name: string): string {
  return join(runDir, `${name}.mp4`)
}
