import type { RequestHandler } from 'express'
import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { parsePublicGamesQuery } from '../events/eventListQuery'
import { publicGamesPage } from '../groups/publicSummary'
import { withAsync } from '../middleware/withErrors'

/**
 * The public side of a group's games, ahead of whatever else its path does:
 * with `public` it answers, to anybody, what the group's public page shows,
 * and without it the request goes on as if this were not here.
 */
export function publicGamesRoute(
  db: Kysely<Database>,
  kind: 'team' | 'season'
): RequestHandler {
  return withAsync(async (req, res, next) => {
    if (req.query.public == null) {
      next()
      return
    }
    const id = String(req.params[`${kind}Id`])
    res.json(
      await publicGamesPage(
        db,
        { kind, id },
        req.actor,
        parsePublicGamesQuery(req.query)
      )
    )
  })
}
