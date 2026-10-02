import React from 'react'
import { createRoot } from 'react-dom/client'
import { AppRegistry } from 'react-native'

import { App } from '../App'
import { ScoreboardPage } from '../scoreboard/ScoreboardPage'
import { scoreboardPageFor } from '../scoreboard/scoreboardRoute'

/**
 * The web entry point.
 *
 * `AppRegistry` rather than `createRoot` directly: it is what injects
 * react-native-web's stylesheet and sets up the root the way the native
 * runtime would, so the same components behave the same way here as they will
 * on a phone.
 */
declare const TS_API_BASE_URL: string
declare const TS_FIELD_PREVIEW: boolean

const fieldPreview = typeof TS_FIELD_PREVIEW !== 'undefined' && TS_FIELD_PREVIEW

const apiBaseUrl =
  typeof TS_API_BASE_URL === 'string' ? TS_API_BASE_URL : '/api/v1'

export interface WebStart {
  document: Document
  location: Pick<Location, 'pathname' | 'search' | 'protocol' | 'host'>
  apiBaseUrl: string
  fieldPreview?: boolean
  registry?: Pick<typeof AppRegistry, 'registerComponent' | 'runApplication'>
}

/**
 * Starts whichever program the address is for.
 *
 * A scoreboard page (`/scoreboard/<gameId>`, `/scoreboard-sample`) is not the
 * app: it needs no session, so it must never ask `/auth/me`, and it is drawn
 * over video, so nothing behind it may paint. `index.html` gives `html`,
 * `body` and `#root` the cream page fill, and `#root` would paint it behind
 * the board, so all three are made transparent. The app itself is never
 * registered or run. The board is react-native-web's all the same, and needs
 * nothing from `AppRegistry` to draw: react-native-web writes each style into
 * its style sheet in the page's head when `StyleSheet.create` is called.
 */
export function startWeb(start: WebStart): 'scoreboard' | 'app' {
  const { document, location } = start
  const rootTag = document.getElementById('root')
  if (rootTag == null) {
    throw new Error('The page has no #root for the app to render into')
  }
  const page = scoreboardPageFor(location.pathname, location.search)
  if (page != null) {
    for (const element of [document.documentElement, document.body, rootTag]) {
      element.style.background = 'transparent'
      element.style.margin = '0'
    }
    // 1.0's page root is a plain block (`src/client/index.html` at 25f9496e). This page's
    // `#root` is a flex row, which would stretch the board to the web view.
    rootTag.style.display = 'block'
    createRoot(rootTag).render(
      <ScoreboardPage
        page={page}
        apiBaseUrl={start.apiBaseUrl}
        origin={{ protocol: location.protocol, host: location.host }}
      />
    )
    return 'scoreboard'
  }

  const registry = start.registry ?? AppRegistry
  function Root(): React.ReactElement {
    return (
      <App apiBaseUrl={start.apiBaseUrl} fieldPreview={start.fieldPreview} />
    )
  }
  registry.registerComponent('TeamStation', () => Root)
  // `runApplication` is typed for the native runtime, where `rootTag` is an
  // opaque number. On web, react-native-web wants the DOM element itself — the
  // same call, a different contract, and the types describe only one of them.
  // Stated once here rather than leaving the module untyped, as it was for as
  // long as react-native silently resolved to `any`.
  registry.runApplication('TeamStation', {
    rootTag
  } as unknown as Parameters<typeof AppRegistry.runApplication>[1])
  return 'app'
}

// The tests import `startWeb` and run it against a document of their own.
if (process.env.NODE_ENV !== 'test') {
  startWeb({ document, location: window.location, apiBaseUrl, fieldPreview })
}
