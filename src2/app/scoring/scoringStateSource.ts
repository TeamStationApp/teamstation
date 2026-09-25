import type { GameDetail, RosterEntry } from '../../common/api'
import { createDevelopmentSession } from './developmentSession'
import type { ScoringSessionState } from './scoringTypes'

export interface ScoringStateSource {
  load: (
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[]
  ) => Promise<ScoringSessionState>
  save: (state: ScoringSessionState) => Promise<void>
}
export class DevelopmentScoringStateSource implements ScoringStateSource {
  async load(
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[]
  ): Promise<ScoringSessionState> {
    return createDevelopmentSession(game, away, home)
  }

  async save(_state: ScoringSessionState): Promise<void> {
    /* Development sessions never write to the server. */
  }
}
