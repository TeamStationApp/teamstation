import { readFile } from 'node:fs/promises'

import pg from 'pg'

import { spacePartReader } from '../server/live/spacePieceReader'
import { spaceConfigured, type SpaceSettings } from '../server/media/spacesHls'
import type { VideoPath } from '../server/media/videoPrefix'

/**
 * Reading a live recording's pieces in an end-to-end test.
 *
 * While a stream publishes to a Space, the ingest keeps only the newest
 * minute of it on disk (`live.localTailSec`): an older piece is deleted once
 * the Space holds it. A test that reads every piece the local playlist lists
 * reads each from the ingest's directory first, as before, and one that is
 * no longer there from the Space, by a presigned GET of its key.
 */

/** Where a live video's pieces are kept in the Space. */
export interface LivePieceSpace {
  space: SpaceSettings
  video: VideoPath
}

/** The bytes of one file of a live recording, by its path on disk. */
export type LivePieceReader = (path: string) => Promise<Uint8Array>

/**
 * Reads a piece from disk, and one the disk no longer holds from the Space
 * `where` names. `where` is asked once, and only when a piece is missing, so
 * a test whose pieces are all on disk never looks for a Space. With no Space,
 * a missing piece fails as it did before, with the disk's `ENOENT`.
 */
export function livePieceReader(
  where: () => Promise<LivePieceSpace | undefined>
): LivePieceReader {
  let found: Promise<LivePieceSpace | undefined> | undefined
  return async path => {
    try {
      return await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      found ??= where()
      const source = await found
      if (source == null) throw error
      return await spacePartReader(source.space, source.video)(path)
    }
  }
}

/**
 * The Space of this machine's server configuration (`serverConfig.json` in
 * the working directory, as the server reads it), with the video's prefix
 * from its row's `space_secret`. Undefined when no Space is configured. The
 * configuration is loaded only when this is called.
 */
export async function serverLivePieceSpace(
  videoId: string
): Promise<LivePieceSpace | undefined> {
  const { serverConfig } = await import('../server/serverConfig')
  const space = serverConfig.space
  if (space == null || !spaceConfigured(space)) return undefined
  const client = new pg.Client({ connectionString: serverConfig.databaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ space_secret: string | null }>(
      'select space_secret from videos where id = $1',
      [videoId]
    )
    return {
      space,
      video: { id: videoId, spaceSecret: rows[0]?.space_secret ?? null }
    }
  } finally {
    await client.end()
  }
}

/** A reader for one video's live pieces, against this machine's server. */
export function serverLivePieceReader(videoId: string): LivePieceReader {
  return livePieceReader(async () => await serverLivePieceSpace(videoId))
}
