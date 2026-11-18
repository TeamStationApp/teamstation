import type { VideoHandle } from '../videoHandle'

/**
 * One picture on the multi-camera grid, as the grid's own logic sees it.
 *
 * A `VideoHandle` and the few more things a browser's `<video>` says about
 * itself — whether it has ended, how far it can seek, how much it holds ahead,
 * how many pictures it has drawn. In a browser the tile *is* the element; on a
 * phone it is a `NativeVideoHandle`, which knows when it has ended and leaves
 * the rest out, and the grid works from what is there.
 */
export interface TileHandle extends VideoHandle {
  readonly ended?: boolean
  /** Still moving to where it was last sent; a browser says, a phone does not. */
  readonly seeking?: boolean
  readonly seekable?: { length: number; end: (index: number) => number }
  /**
   * A phone's player that has gone quiet: the seekable end it last reported
   * is where its footage had reached, and may since have grown.
   */
  readonly seekableQuiet?: boolean
  readonly buffered?: {
    length: number
    start: (index: number) => number
    end: (index: number) => number
  }
  getVideoPlaybackQuality?: () => { totalVideoFrames: number }
}
