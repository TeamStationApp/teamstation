import React from 'react'
import { AppRegistry } from 'react-native'

import { App } from '../App'
import { showRoute } from '../navigation/useAddressBar'

/**
 * The web entry point.
 *
 * `AppRegistry` rather than `createRoot` directly: it is what injects
 * react-native-web's stylesheet and sets up the root the way the native
 * runtime would, so the same components behave the same way here as they will
 * on a phone.
 */
declare const GS_API_BASE_URL: string
declare const GS_FIELD_PREVIEW: boolean

const fieldPreview = typeof GS_FIELD_PREVIEW !== 'undefined' && GS_FIELD_PREVIEW
if (fieldPreview && window.location.pathname === '/') {
  showRoute({ name: 'field' }, true)
}

const apiBaseUrl =
  typeof GS_API_BASE_URL === 'string' ? GS_API_BASE_URL : '/api/v1'

function Root(): React.ReactElement {
  return <App apiBaseUrl={apiBaseUrl} fieldPreview={fieldPreview} />
}

AppRegistry.registerComponent('GameStation', () => Root)

const rootTag = document.getElementById('root')
if (rootTag == null) {
  throw new Error('The page has no #root for the app to render into')
}
// `runApplication` is typed for the native runtime, where `rootTag` is an
// opaque number. On web, react-native-web wants the DOM element itself — the
// same call, a different contract, and the types describe only one of them.
// Stated once here rather than leaving the module untyped, as it was for as
// long as react-native silently resolved to `any`.
AppRegistry.runApplication('GameStation', {
  rootTag
} as unknown as Parameters<typeof AppRegistry.runApplication>[1])
