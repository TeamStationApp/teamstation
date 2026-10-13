/** Isolated native smoke entry; the product entry never imports it. */
import React from 'react'
import { AppRegistry, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { HeaderSlotProvider } from '../app/components/headerSlot'
import { TeamScreen } from '../app/screens/TeamScreen'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asTeamSummary, TeamStationClient } from '../common/api'
import { TEAM_ID, teamScheduleAnswer } from './teamScheduleFixture'

const now = Date.now()
const team = asTeamSummary(
  (teamScheduleAnswer('GET', '/teams', now).body as unknown[])[0]
)
const client = new TeamStationClient({
  baseUrl: 'https://fixture.example.test/api/v1',
  fetch: async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const answer = teamScheduleAnswer(init?.method ?? 'GET', url, now)
    if (new URL(url).pathname === `/api/v1/teams/${TEAM_ID}/games`)
      answer.body = (answer.body as Array<Record<string, unknown>>).map(
        game => ({
          ...game,
          playerRsvps: { yes: 0, unknown: 13, no: 0 }
        })
      )
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }
})
const ignore = (): void => undefined

export function PinnedScheduleSmoke(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeProvider>
          <View style={{ flex: 1 }}>
            <HeaderSlotProvider headerHeight={100} onHandoff={ignore}>
              <TeamScreen
                client={client}
                team={team}
                initialTab="schedule"
                onOpenGame={ignore}
              />
            </HeaderSlotProvider>
            <View
              pointerEvents="none"
              style={{ position: 'absolute', top: 60, left: 24 }}
            >
              <Text testID="pinned-schedule-smoke-alive">Schedule smoke</Text>
            </View>
          </View>
        </ThemeProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => PinnedScheduleSmoke)
