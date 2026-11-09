import type { PostEventsBody } from '../../common/gumboPlay'
import type { SideTeams } from '../../common/scoring/teamRecord'
import { playFromWire } from '../../common/scoring/wireRecord'

/**
 * Records as they travel (`common/scoring/wireRecord`): stored by team,
 * carried by side. The phone swaps its own copy with the same transforms.
 */
export {
  playForWire,
  playFromWire,
  recordIn
} from '../../common/scoring/wireRecord'

/** A post's plays and at-bat in progress, as they are stored. */
export function bodyFromWire(
  body: PostEventsBody,
  teams: SideTeams
): PostEventsBody {
  return {
    ...body,
    plays: body.plays.map(play => playFromWire(play, teams)),
    ...(body.scoringHistory == null
      ? {}
      : {
          scoringHistory: body.scoringHistory.map(play =>
            playFromWire(play, teams)
          )
        }),
    ...(body.currentPlay == null
      ? {}
      : { currentPlay: playFromWire(body.currentPlay, teams) })
  }
}
