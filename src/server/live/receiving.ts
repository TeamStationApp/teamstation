import type { Kysely } from 'kysely'

import { asLiveStatus } from '../../common/api'
import type { Database } from '../db/database'

/**
 * Whether the ingest's last snapshot says bytes are arriving.
 *
 * `publishing` on the row is a connection. A connected encoder can sit there
 * sending nothing, and that is not a live picture.
 */
export function ingressReceiving(status: unknown): boolean {
  if (status == null) return false
  try {
    return asLiveStatus(status).ingress.bytesPerSecond > 0
  } catch {
    return false
  }
}

/**
 * Videos among `videoIds` that have a stream in `publishing` whose last
 * snapshot shows bytes arriving. A stream that connected and then went idle
 * is not in the set, even while its video row is still `live`.
 */
export async function receivingVideoIds(
  db: Kysely<Database>,
  videoIds: readonly string[]
): Promise<Set<string>> {
  if (videoIds.length === 0) return new Set()
  const rows = await db
    .selectFrom('live_streams')
    .select(['video_id as videoId', 'status'])
    .where('video_id', 'in', [...videoIds])
    .where('state', '=', 'publishing')
    .execute()
  const receiving = new Set<string>()
  for (const row of rows) {
    if (row.videoId != null && ingressReceiving(row.status))
      receiving.add(row.videoId)
  }
  return receiving
}
