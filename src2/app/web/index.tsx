import React from 'react'
import { AppRegistry } from 'react-native'

import { App } from '../App'

/**
 * The web entry point.
 *
 * `AppRegistry` rather than `createRoot` directly: it is what injects
 * react-native-web's stylesheet and sets up the root the way the native
 * runtime would, so the same components behave the same way here as they will
 * on a phone.
 */
declare const GS_API_BASE_URL: string

const apiBaseUrl =
  typeof GS_API_BASE_URL === 'string' ? GS_API_BASE_URL : '/api/v1'

function Root(): React.ReactElement {
  return <App apiBaseUrl={apiBaseUrl} />
}

AppRegistry.registerComponent('GameStation', () => Root)

const rootTag = document.getElementById('root')
if (rootTag == null) {
  throw new Error('The page has no #root for the app to render into')
}
AppRegistry.runApplication('GameStation', { rootTag })
