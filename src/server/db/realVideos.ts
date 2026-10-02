import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from 'kysely'

import type { Database } from './database'

/**
 * A row in `videos` that is a recording somebody could watch, or could have.
 *
 * Two quite different things arrive as `status <> 'ready'`, and only one of
 * them is a video:
 *
 * - **A recording whose file has gone.** Real length, real content, and the
 *   bytes are not reachable now. It stays listed: it is part of the game's
 *   record, and saying the file is missing beats pretending the game was never
 *   filmed.
 * - **A live-stream stub.** Zero length, and no content ever existed —
 *   PeerTube wrote the row when a stream was started. On production these are
 *   the two rows titled `Live` and one titled `Live Test 2`.
 *
 * The second kind is not a camera angle, and drawing it as one is how a game
 * with two recordings offered a `Primary 3 (unavailable)` pill. Nobody ever
 * had a third camera; they had a stub.
 *
 * `duration_sec > 0` is the test rather than the title, because the titles are
 * whatever somebody typed into PeerTube and the next one will be called
 * something else.
 *
 * A stream **being received right now** is the third case, and it is real: it
 * has no duration yet, because it is still happening. Only this server's own
 * live ingest ever writes `status = 'live'`; every imported row arrives as
 * `ready` and is marked unavailable later if its files turn out to be missing,
 * so nothing legacy comes back through this door.
 */
export function isRealVideo(
  eb: ExpressionBuilder<Database, 'videos'>
): ExpressionWrapper<Database, 'videos', SqlBool> {
  return eb.or([
    eb('videos.status', '=', 'ready'),
    eb('videos.status', '=', 'live'),
    eb('videos.duration_sec', '>', 0)
  ])
}
