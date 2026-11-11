import React from 'react'
import { AppRegistry } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { ButtonIconsFixture } from './buttonIcons.fixture'

function Root(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ButtonIconsFixture />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => Root)
