import type { GameDetail, MyRoles, RosterEntry } from '../../common/api'
import type { DefaultLineups } from '../../common/scoring/startingSetup'

/** What the scoring screen read as it opened a game. */
export interface OpenedReads {
  game: GameDetail
  roles: MyRoles | undefined
  /** Whether the person manages each team's roster, as its roster was read. */
  rights: Record<string, boolean>
  /** Each team's roster, by team id. */
  rosters: Record<string, RosterEntry[]>
  defaults: DefaultLineups
}
