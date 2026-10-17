import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Text } from 'react-native'

import { GameScreen } from '../app/screens/GameScreen'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail, TeamStationClient } from '../common/api'

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
  hasScoringEvents: false
})
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
      <Text accessibilityRole="status">Action: {action}</Text>
      <GameScreen
        client={client}
        gameId={game.id}
        initialTab="watch"
        recording={{
          open: () => {
            setAction('Record')
          }
        }}
        onCoachGame={() => {
          setAction('Coach')
        }}
      />
    </ThemeProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
