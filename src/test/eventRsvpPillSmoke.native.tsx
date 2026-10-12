/** Explicit simulator smoke entry; the product entry never imports it. */
import React, { useState } from 'react'
import { AppRegistry, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { Emblem } from '../app/components/Emblem'
import { EventRsvpPill } from '../app/components/EventRsvpPill'
import { ThemeProvider } from '../app/theme/ThemeContext'
import type { RsvpChoice } from '../common/eventInfo'

function Smoke(): React.ReactElement {
  const [response, setResponse] = useState<RsvpChoice>(null)
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <View
          style={{
            flex: 1,
            paddingHorizontal: 20,
            paddingTop: 100,
            backgroundColor: '#f5f7f1',
            gap: 24
          }}
        >
          <Text style={{ fontSize: 24, color: '#20391b' }}>Are you going?</Text>
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
              Babe Ruth
            </Text>
            <EventRsvpPill
              name="Babe Ruth"
              userId={101}
              value={response}
              onChange={setResponse}
            />
          </View>
          <Text testID="smoke-response" style={{ color: '#20391b' }}>
            Response: {response ?? 'No reply'}
          </Text>
        </View>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => Smoke)
