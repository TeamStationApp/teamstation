import React from 'react'
import { createRoot } from 'react-dom/client'
import { View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { createDevelopmentSession } from '../app/scoring/developmentSession'
import { ScoringScreen } from '../app/scoring/ScoringScreen'
import { memoryStore, type ScoringSource } from '../app/scoring/scoringSource'
import { POSITIONS } from '../app/scoring/scoringTypes'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail, asRosterEntry, TeamStationClient } from '../common/api'
import { ScoringSession } from '../common/scoring/session'

const game = asGameDetail({
  id: 'pickoff-reset',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Silver Rockets',
  homeTeamName: 'Copper Comets',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  nonMemberView: false,
  videos: []
})
const roster = (side: string): Array<ReturnType<typeof asRosterEntry>> =>
  POSITIONS.map((position, i) =>
    asRosterEntry({
      userId: (side === 'home' ? 200 : 100) + i,
      shortName: `${side === 'home' ? 'Host' : 'Visitor'} ${String(i + 1).padStart(2, '0')}`,
      jersey: String(i + 1),
      positions: [position],
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null,
      bats: 'right',
      throws: 'right'
    })
  )
const client = new TeamStationClient({ baseUrl: '/api/v1' })
client.game = async () => game
client.roster = async side => roster(side)
client.defaultLineup = async () => ({
  lineup: null,
  fromGameId: null,
  setAt: null
})
client.myRoles = async () => {
  throw new Error('No account in the isolated fixture')
}
const source: ScoringSource = {
  open: async () => {
    const session = ScoringSession.start(
      memoryStore(),
      game.id,
      createDevelopmentSession(game, roster('away'), roster('home'))
    )
    session.subscribe(() => {
      fetch('/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actions: session.actions,
          line: session.state.liveData.linescore
        })
      }).catch((error: unknown) => {
        console.error(error)
      })
    })
    return session
  }
}
function Root(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <View style={{ flex: 1 }}>
          <ScoringScreen
            client={client}
            gameId={game.id}
            userId="pickoff-fixture"
            source={source}
            onExit={() => undefined}
          />
        </View>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'flex', height: '100dvh' }}>
    <Root />
  </div>
)
