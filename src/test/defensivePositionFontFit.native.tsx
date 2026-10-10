import React from 'react'
import { AppRegistry, LogBox } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { DefensivePositionFontFitFixture } from './defensivePositionFontFit.fixture'

LogBox.ignoreAllLogs()

function FontFitRoot(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <DefensivePositionFontFitFixture />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => FontFitRoot)
