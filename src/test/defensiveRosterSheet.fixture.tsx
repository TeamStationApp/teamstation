import React, { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'

import { assignDefender } from '../app/scoring/currentSetup'
import {
  DEFENSIVE_POSITION_NAMES,
  DefensiveRosterSheet
} from '../app/scoring/DefensiveRosterSheet'
import { createDevelopmentSession } from '../app/scoring/developmentSession'
import { addPlaceholderPlayers } from '../app/scoring/placeholderPlayers'
import { addRosteredPlayer, rosterPlayerBody } from '../app/scoring/playerDraft'
import { copyState } from '../app/scoring/scoringMachine'
import { ScoringScreen } from '../app/scoring/ScoringScreen'
import { memoryStore, type ScoringSource } from '../app/scoring/scoringSource'
import { type Position, POSITIONS } from '../app/scoring/scoringTypes'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail, asRosterEntry, TeamStationClient } from '../common/api'
import { shortName } from '../common/names'
import { freshGame } from '../common/scoring/rules'
import { ScoringSession } from '../common/scoring/session'
import { setupOf } from '../common/scoring/state'
import { mintedRosterEntry } from './mintedRosterEntry'

const game = asGameDetail({
  nonMemberView: false,
  id: 'defensive-roster',
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
const names = [
  'Mookie Betts',
  'Mike Trout',
  'Shohei Ohtani',
  'Aaron Judge',
  'Bryce Harper',
  'Freddie Freeman',
  'Francisco Lindor',
  'Juan Soto',
  'Bobby Witt',
  'Julio Rodriguez',
  'Nolan Arenado',
  'Ronald Acuna'
]
const numbers = [
  '50',
  '27',
  '17',
  '99',
  '3',
  '5',
  '12',
  '22',
  '7',
  '44',
  '',
  '0'
]
const roster = (side: string): Array<ReturnType<typeof asRosterEntry>> =>
  names.map((displayName, i) =>
    asRosterEntry({
      userId: (side === 'home' ? 200 : 100) + i,
      shortName: shortName({ id: i, displayName }),
      jersey: numbers[i],
      positions: [POSITIONS[i % 9]],
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null,
      bats: 'right',
      throws: 'right'
    })
  )
const initial = createDevelopmentSession(game, roster('away'), roster('home'))
const home = initial.liveData.boxscore.teams.home
for (const [i, position] of POSITIONS.entries())
  home.defense[position] = home.players[i]
home.defense.P = null
home.defense.LF = null
const client = new TeamStationClient({
  baseUrl: 'https://api.example.test/api/v1'
})
client.game = async () => game
client.roster = async side => roster(side)
client.createRosterPlayer = async (_teamId, player) => mintedRosterEntry(player)
const source: ScoringSource = {
  open: async () =>
    ScoringSession.start(
      memoryStore(),
      game.id,
      freshGame(game.id, initial.gameData.teams, setupOf(initial)),
      { requireCurrentSetup: true }
    )
}

/** Complete production scoring screen with an isolated, in-memory game. */
export function DefensiveScoringScreenFixture(): React.ReactElement {
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

/** Real native popup/forms; the browser also exercises the actual 3D scoring screen. */
export function DefensiveRosterSheetFixture(): React.ReactElement {
  const [session, setSession] = useState(initial)
  const [position, setPosition] = useState<Position | undefined>('P')
  return (
    <ThemeProvider>
      <View style={{ flex: 1, paddingTop: Platform.OS === 'web' ? 0 : 64 }}>
        {Platform.OS === 'web' ? (
          <ScoringScreen
            client={client}
            gameId={game.id}
            userId={123}
            source={source}
            onExit={() => undefined}
          />
        ) : (
          <>
            {position == null &&
              POSITIONS.map(slot => (
                <Pressable
                  key={slot}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${DEFENSIVE_POSITION_NAMES[slot]}`}
                  onPress={() => {
                    setPosition(slot)
                  }}
                  style={{ minHeight: 44, padding: 10 }}
                >
                  <Text>{DEFENSIVE_POSITION_NAMES[slot]}</Text>
                </Pressable>
              ))}
            {position != null && (
              <DefensiveRosterSheet
                session={session}
                side="home"
                position={position}
                onClose={() => {
                  setPosition(undefined)
                }}
                onRefresh={() => undefined}
                onChoose={id => {
                  setSession(assignDefender(session, position, id))
                  setPosition(undefined)
                }}
                onAddPlayer={async draft => {
                  const entry = mintedRosterEntry(rosterPlayerBody(draft))
                  setSession(previous => {
                    const next = copyState(previous)
                    addRosteredPlayer(next, 'home', entry, draft)
                    return next
                  })
                }}
                onAddPlaceholders={async count => {
                  setSession(previous => {
                    const next = copyState(previous)
                    addPlaceholderPlayers(next, 'home', count)
                    return next
                  })
                }}
              />
            )}
          </>
        )}
      </View>
    </ThemeProvider>
  )
}
