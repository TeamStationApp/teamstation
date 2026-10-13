/** Explicit simulator smoke entry; the product entry never imports it. */
import React, { useState } from 'react'
import { AppRegistry, ScrollView, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { Card } from '../app/components/Card'
import { Emblem } from '../app/components/Emblem'
import { EventMap } from '../app/components/EventMap'
import { EventRsvpPill } from '../app/components/EventRsvpPill'
import { EventScheduleFields } from '../app/components/EventScheduleFields'
import { SectionHeader } from '../app/components/SectionHeader'
import { ThemeProvider } from '../app/theme/ThemeContext'
import type { RsvpChoice } from '../common/eventInfo'
import { newEventSchedule } from '../common/eventSchedule'

function Smoke(): React.ReactElement {
  const [response, setResponse] = useState<RsvpChoice>(null)
  const [schedule, setSchedule] = useState(() =>
    newEventSchedule('2032-02-29T23:30:00Z', null, 'UTC')
  )
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 100,
            paddingBottom: 80,
            backgroundColor: '#f5f7f1',
            gap: 16
          }}
        >
          <SectionHeader title="Are you going?" note="1" />
          <Card>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap'
              }}
            >
              <Emblem fallback="BR" shape="circle" size={2} />
              <Text style={{ flex: 1, minWidth: 40, color: '#20391b' }}>
                Babe R
              </Text>
              <EventRsvpPill
                name="Babe R"
                userId={101}
                value={response}
                onChange={setResponse}
              />
            </View>
            <Text testID="smoke-response" style={{ color: '#20391b' }}>
              Response: {response ?? 'No reply'}
            </Text>
          </Card>
          <Card>
            <EventMap
              location={{
                latitude: 34,
                longitude: 12,
                tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
              }}
            />
            <Text style={{ color: '#20391b' }}>1 Demo Way, Demo City</Text>
          </Card>
          <Card>
            <EventScheduleFields value={schedule} onChange={setSchedule} />
            <Text testID="smoke-schedule" style={{ color: '#20391b' }}>
              Schedule: {schedule.time} · {schedule.endDate}
            </Text>
          </Card>
        </ScrollView>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => Smoke)
