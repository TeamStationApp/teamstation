import type { MyRoles, RosterEntry } from '../../common/api'
import type { DefaultLineups } from '../../common/scoring/startingSetup'
import type { NamedGameDetail } from './scoringSource'

/** What the scoring screen read as it opened a game. */
export interface OpenedReads {
  game: NamedGameDetail
  roles: MyRoles | undefined
  /** Whether the person manages each team's roster, as its roster was read. */
  rights: Record<string, boolean>
  /** Each team's roster, by team id. */
  rosters: Record<string, RosterEntry[]>
  defaults: DefaultLineups
}
