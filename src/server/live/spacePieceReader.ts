import { basename } from 'node:path'

import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'
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

/** How many times in all a piece is asked for, and how far apart. */
const PIECE_READ_ATTEMPTS = 3
const PIECE_RETRY_MS = 500

/** What a read of one piece may be given: tests make it short. */
export interface PieceReadOptions {
  timeoutMs?: number
  attempts?: number
  retryMs?: number
}

/**
 * Reads a live recording's file from its directory, or, when the disk tail
 * has deleted it, from the Space, by a presigned GET of its key (with a
 * `Range` for a byte range). A close reads the whole recording this way.
 *
 * A close of a three-hour game reads a few thousand pieces, and one failed
 * read fails the close, which then starts again from the first piece. So a
 * read the Space may answer next time (a 5xx, a 429 or 503 slow-down, a
 * timeout or a dropped connection) is asked again, `attempts` times in all;
 * one it never will (403, 404) fails at once.
 */
export function spacePartReader(
  space: SpaceSettings,
  videoId: string,
  {
    timeoutMs = PIECE_READ_TIMEOUT_MS,
    attempts = PIECE_READ_ATTEMPTS,
    retryMs = PIECE_RETRY_MS
  }: PieceReadOptions = {}
): PartReader {
  return async (path, range) => {
    try {
      return await readPart(path, range)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const name = basename(path)
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined
      let failure: unknown
      try {
        response = await fetch(
          presignGetUrl({
            ...space,
            key: objectKey(videoId, name),
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
        if (response.ok) return new Uint8Array(await response.arrayBuffer())
      } catch (error) {
        // A timeout or a dropped connection, asking or reading the body.
        failure = error
      }
      if (response != null && !response.ok) {
        await response.body?.cancel()
        failure = new Error(
          `Reading ${name} from the Space answered ${response.status}`
        )
        // One the Space will answer the same way again.
        if (response.status < 500 && response.status !== 429) throw failure
      }
      if (attempt >= attempts) throw failure
      await new Promise(resolve => setTimeout(resolve, retryMs * attempt))
    }
  }
}
