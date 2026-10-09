import React from 'react'
import { AppRegistry, LogBox } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { DefensiveRosterSheetFixture } from './defensiveRosterSheet.fixture'

LogBox.ignoreAllLogs()
function Root(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <DefensiveRosterSheetFixture />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => Root)
