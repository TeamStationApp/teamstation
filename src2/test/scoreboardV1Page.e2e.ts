import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'

import type { ScoreboardState } from '../common/scoreboard'

/**
 * 1.0's scoreboard, `src/client/Scoreboard.tsx`, as a page of its own, for
 * E6 to compare the ported board against in the same browser.
 *
 * It is bundled as 1.0's webpack bundled it: react-native-web for
 * `react-native`, react-native-web-linear-gradient for the gradient, and
 * 1.0's `AppRegistry` start and theme provider. 1.0's own socket is answered
 * by a stand-in that sends `state` on open, and its router by one that names
 * any event. Nothing of 1.0's is changed.
 */
export async function scoreboardV1Html(
  state: ScoreboardState
): Promise<string> {
  const repo = join(__dirname, '../..')
  const stubs = mkdtempSync(join(tmpdir(), 'scoreboardV1-'))
  try {
    writeFileSync(
      join(stubs, 'router.js'),
      "export const useParams = () => ({ eventId: 'sample' })\n"
    )
    writeFileSync(join(stubs, 'clientConfig.json'), '{}\n')
    const entry = `
      import React from 'react'
      import { AppRegistry } from 'react-native'
      import Scoreboard from './src/client/Scoreboard'
      import { ThemeProvider } from './src/client/ThemeContext'

      const state = ${JSON.stringify(state)}
      class StandInSocket {
        constructor() {
          setTimeout(() => {
            if (this.onopen) this.onopen()
            if (this.onmessage) this.onmessage({ data: JSON.stringify(state) })
          }, 0)
        }
        close() {}
      }
      window.WebSocket = StandInSocket

      function App() {
        return React.createElement(ThemeProvider, null,
          React.createElement(Scoreboard))
      }
      AppRegistry.registerComponent('gamestation', () => App)
      AppRegistry.runApplication('gamestation', {
        rootTag: document.getElementById('root')
      })
    `
    const result = await build({
      stdin: { contents: entry, resolveDir: repo, sourcefile: 'v1.tsx' },
      bundle: true,
      write: false,
      format: 'iife',
      target: ['es2021'],
      jsx: 'automatic',
      loader: { '.tsx': 'tsx' },
      resolveExtensions: [
        '.web.tsx',
        '.web.ts',
        '.web.js',
        '.tsx',
        '.ts',
        '.js',
        '.json'
      ],
      alias: {
        'react-native': 'react-native-web',
        'react-native-linear-gradient': 'react-native-web-linear-gradient',
        'react-router-dom': join(stubs, 'router.js')
      },
      plugins: [
        {
          name: 'clientConfig',
          setup(plugin) {
            plugin.onResolve({ filter: /clientConfig\.json$/ }, () => ({
              path: join(stubs, 'clientConfig.json')
            }))
          }
        }
      ],
      define: {
        'process.env.NODE_ENV': '"production"',
        __DEV__: 'false',
        global: 'globalThis'
      },
      logLevel: 'warning'
    })
    const script = result.outputFiles[0].text.replace(
      /<\/script/gi,
      '<\\/script'
    )
    // 1.0's `src/client/index.html`, without its web font: the board is set
    // in Helvetica Neue.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html, body { margin: 0; padding: 0; background-color: #1F2418; height: 100%; }
    #root { height: 100%; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>${script}</script>
</body>
</html>`
  } finally {
    rmSync(stubs, { recursive: true, force: true })
  }
}
