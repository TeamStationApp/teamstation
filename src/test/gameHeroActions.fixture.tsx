import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Text, View } from 'react-native'

import { ScoreGameScreen } from '../app/scoreboard/ScoreGameScreen'
import { GameScreen } from '../app/screens/GameScreen'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail, TeamStationClient } from '../common/api'
import { asRoleFlag } from '../common/roles'

const game = asGameDetail({
  nonMemberView: false,
  id: 'game-actions',
  homeTeamId: 'home',
  awayTeamId: 'away',
  homeTeamName: 'Owls',
  awayTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  endAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  ingestMessage: null,
  videos: [],
  canScore: true,
  canDj: true,
  coachSides: ['home'],
  assignedRoles: {
    away: [],
    home: ['coach', 'scorekeeper', 'songkeeper', 'videographer']
  },
  hasScoringEvents: false
})
const selectedRole = new URLSearchParams(location.search).get('role')
if (selectedRole != null)
  game.assignedRoles = {
    away: [],
    home:
      selectedRole === 'admin'
        ? ['admin']
        : selectedRole === 'none'
          ? []
          : [asRoleFlag(selectedRole)]
  }
const client = new TeamStationClient({ baseUrl: '/api/v1' })
client.game = async () => game
client.teams = async () => []
client.gameScheduling = async () => {
  throw new Error('No scheduling in this fixture')
}
function Fixture(): React.ReactElement {
  const [action, setAction] = useState('none')
  return (
    <ThemeProvider>
      <View style={{ flex: 1 }}>
        <Text accessibilityRole="status">{`Action: ${action}`}</Text>
        {action === 'Score' ? (
          <ScoreGameScreen
            client={client}
            gameId={game.id}
            onFullScoring={() => {}}
            onScoreboard={() => {}}
          />
        ) : (
          <GameScreen
            client={client}
            gameId={game.id}
            initialTab="watch"
            onScoreGame={() => {
              setAction('Score')
            }}
            recording={{
              open: () => {
                setAction('Record')
              }
            }}
            onCoachGame={() => {
              setAction('Coach')
            }}
            onDjGame={() => {
              setAction('DJ')
            }}
          />
        )}
      </View>
    </ThemeProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
