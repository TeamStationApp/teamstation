import { basename } from 'node:path'

import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'
import type { VideoPath } from '../media/videoPrefix'
import { type PartReader, readPart } from '../media/wallClockScan'
import { objectKey } from './originPublish'

/**
 * Reading back the pieces of a live recording that the disk tail deleted.
 * Apart from the publisher, so a test that reads a recording's pieces does
 * not bring in everything the publisher does.
 */

/**
 * How long one read of a deleted piece from the Space may take, headers and
 * body. A piece is a few megabytes; a read that stalls would otherwise hold
 * the video's queue, and its close, for undici's five minutes.
 */
const PIECE_READ_TIMEOUT_MS = 30_000

/**
 * Reads a live recording's file from its directory, or, when the disk tail
 * has deleted it, from the Space, by a presigned GET of its key (with a
 * `Range` for a byte range). A close reads the whole recording this way.
 */
export function spacePartReader(
  space: SpaceSettings,
  video: VideoPath,
  timeoutMs = PIECE_READ_TIMEOUT_MS
): PartReader {
  return async (path, range) => {
    try {
      return await readPart(path, range)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const name = basename(path)
    const response = await fetch(
      presignGetUrl({
        ...space,
        key: objectKey(video, name),
        expiresSec: 300
      }),
      {
        signal: AbortSignal.timeout(timeoutMs),
        ...(range == null
          ? {}
          : {
              headers: {
                range: `bytes=${range.offset}-${range.offset + range.length - 1}`
              }
            })
      }
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Reading ${name} from the Space answered ${response.status}`
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }
}
