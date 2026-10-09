import React from 'react'
import { AppRegistry, LogBox } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { DefensiveScoringScreenFixture } from './defensiveRosterSheet.fixture'

// Keep known dependency notices off the scorer while retaining error reports.
LogBox.ignoreLogs([
  'Require cycle: src/app/scoring/scoringMachine.ts',
  'The global process.env.EXPO_OS is not defined.',
  'THREE.Clock: This module has been deprecated.',
  'THREE.WebGLRenderer: EXT_color_buffer_float extension not supported.'
])

function Root(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <DefensiveScoringScreenFixture />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}

AppRegistry.registerComponent('TeamStation', () => Root)
