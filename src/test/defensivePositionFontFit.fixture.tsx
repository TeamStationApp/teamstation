import React from 'react'
import { View } from 'react-native'

import { createDevelopmentSession } from '../app/scoring/developmentSession'
import { ScoringScreen } from '../app/scoring/ScoringScreen'
import { memoryStore, type ScoringSource } from '../app/scoring/scoringSource'
import { POSITIONS } from '../app/scoring/scoringTypes'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail, TeamStationClient } from '../common/api'
import { freshGame } from '../common/scoring/rules'
import { ScoringSession } from '../common/scoring/session'
import { setupOf } from '../common/scoring/state'

const game = asGameDetail({
  nonMemberView: false,
  id: 'font-fit',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  videos: []
})
const client = new TeamStationClient({
  baseUrl: 'https://api.example.test/api/v1'
})
client.game = async () => game
client.roster = async () => []
const initial = createDevelopmentSession(game, [], [])
for (const position of POSITIONS)
  initial.liveData.boxscore.teams.home.defense[position] = null
const source: ScoringSource = {
  open: async () =>
    ScoringSession.start(
      memoryStore(),
      game.id,
      freshGame(game.id, initial.gameData.teams, setupOf(initial)),
      { requireCurrentSetup: true }
    )
}

/** The actual scoring field, with all nine slots empty and no server writes. */
export function DefensivePositionFontFitFixture(): React.ReactElement {
  return (
    <ThemeProvider>
      <View style={{ flex: 1 }}>
        <ScoringScreen
          client={client}
          gameId={game.id}
          userId={123}
          source={source}
          onExit={() => undefined}
        />
      </View>
    </ThemeProvider>
  )
}
