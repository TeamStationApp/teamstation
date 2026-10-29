import React, { useEffect, useMemo, useState } from 'react'
import { LogBox, Pressable, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { scoringClock } from '../app/scoring/scoringClock'
import { ScoringScreen } from '../app/scoring/ScoringScreen'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { TeamStationClient } from '../common/api'
import { storedRecordOf } from '../common/scoring/gumbo'
import { baseIds } from '../common/scoring/lineup'
import { ScoringSession } from '../common/scoring/session'
import { setupOf } from '../common/scoring/state'
import {
  priorRunnerFixture,
  priorRunnerGame,
  priorRunnerRoster,
  type PriorRunnerScenario
} from './priorRunnerFixture'

LogBox.ignoreLogs([
  'Require cycle:',
  'The global process.env.EXPO_OS',
  'THREE.Clock:',
  'THREE.WebGLRenderer:'
])
const client = new TeamStationClient({
  baseUrl: 'https://api.example.test/api/v1'
})
client.game = async () => priorRunnerGame
client.roster = async side => priorRunnerRoster(side)

const realScoringNow = scoringClock.now

export function Root(): React.ReactElement {
  const [scenario, setScenario] = useState<PriorRunnerScenario>('first')
  const [revision, setRevision] = useState(0)
  // Keep the open-play fixture open while native accessibility reads finish.
  scoringClock.now = scenario === 'open' ? () => 0 : realScoringNow
  const fixture = useMemo(
    () => priorRunnerFixture(scenario),
    // Each fixture selection creates a fresh saved game.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenario, revision]
  )
  const [reopened, setReopened] = useState<ScoringSession | null>(null)
  const [opened, setOpened] = useState(0)
  const game = reopened ?? fixture.session
  const [, update] = useState(0)
  useEffect(
    () =>
      game.subscribe(() => {
        update(value => value + 1)
      }),
    [game]
  )
  const proof = JSON.stringify({
    open: game.state.pending != null,
    bases: baseIds(game.state),
    score: game.state.liveData.linescore.teams.away.runs,
    count: game.state.liveData.plays.currentPlay?.count,
    times: storedRecordOf(game.picture().current)?.actionTimes
  })
  const source = useMemo(
    () => ({ persistent: false, open: async () => game }),
    [game]
  )
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeProvider>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {(
                [
                  'first',
                  'second',
                  'home',
                  'pitched',
                  'open',
                  'occupied',
                  'timed'
                ] as const
              ).map(name => (
                <Pressable
                  key={name}
                  accessibilityLabel={`Fixture ${name}`}
                  onPress={() => {
                    setReopened(null)
                    setScenario(name)
                    setRevision(v => v + 1)
                  }}
                  style={{
                    paddingHorizontal: 4,
                    paddingVertical: 8,
                    minHeight: 44
                  }}
                >
                  <Text style={{ fontSize: 12 }}>{name}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityLabel="Reopen fixture"
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  justifyContent: 'center'
                }}
                onPress={() => {
                  game
                    .flush()
                    .then(
                      async () =>
                        await ScoringSession.open(
                          fixture.store,
                          game.gameId,
                          {
                            gamePk: game.gameId,
                            teams: game.opening.gameData.teams,
                            setup: setupOf(game.opening)
                          },
                          { setTimer: () => null, clearTimer: () => undefined }
                        )
                    )
                    .then(next => {
                      setReopened(next)
                      setOpened(value => value + 1)
                    })
                    .catch((error: unknown) => {
                      console.error(error)
                    })
                }}
              >
                <Text>↻</Text>
              </Pressable>
            </View>
            <View
              accessible
              accessibilityLabel={`Fixture state ${proof}`}
              style={{ position: 'absolute', width: 1, height: 1, bottom: 0 }}
            />
            <ScoringScreen
              key={`${scenario}-${revision}-${opened}`}
              client={client}
              gameId={priorRunnerGame.id}
              userId="usr_1111111111111111111112"
              source={source}
              onExit={() => undefined}
            />
          </SafeAreaView>
        </ThemeProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
