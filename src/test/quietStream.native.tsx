/** Test-only native entry using the real application and isolated API. */
import React, { useEffect, useState } from 'react'
import { AppRegistry, Text } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { App } from '../app/App'
import { apiBaseUrl } from '../app/native/config'

function QuietStreamNative(): React.ReactElement {
  const [token, setToken] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    fetch(apiBaseUrl.replace(/\/api\/v1$/, '/__quiet/bootstrap'))
      .then(async response => await response.json())
      .then(result => {
        setToken(result.token)
      })
      .catch((error: unknown) => {
        setError(String(error))
      })
  }, [])
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {token == null ? (
          <Text>{error ?? 'Loading isolated stream fixture'}</Text>
        ) : (
          <App apiBaseUrl={apiBaseUrl} initialToken={token} />
        )}
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => QuietStreamNative)
