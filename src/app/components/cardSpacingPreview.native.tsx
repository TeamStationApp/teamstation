import React from 'react'
import { AppRegistry } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { CardSpacingFixture } from './cardSpacingFixture'

function Preview(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <CardSpacingFixture />
    </SafeAreaProvider>
  )
}

AppRegistry.registerComponent('TeamStation', () => Preview)
