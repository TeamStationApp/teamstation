import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect } from 'chai'
import { build } from 'esbuild'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asTeamSummary } from '../common/api'

describe('TV native browser bridge', () => {
  it('opens the native search, forwards authorized results, retries and dismisses', async () => {
    const outfile = path.resolve('lib/tv-browser-native.cjs')
    const { webSettings } = require('../../scripts/web-build-settings.mjs')
    await build({
      ...webSettings,
      stdin: {
        contents:
          "export { TvBrowser } from './src/app/tv/TvBrowser'; export { nativeViews } from './src/test/tvBrowserNativeRuntime'",
        resolveDir: process.cwd(),
        loader: 'tsx'
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      sourcemap: true,
      external: ['react', 'react-dom'],
      plugins: [
        ...webSettings.plugins,
        {
          name: 'native-presentation-bridge',
          setup(builder: any) {
            builder.onLoad(
              { filter: /app\/tv\/NativePresentation\.tsx$/ },
              (args: any) => ({
                contents: readFileSync(args.path, 'utf8').replace(
                  "from 'react-native'",
                  "from '../../test/tvBrowserNativeRuntime'"
                ),
                loader: 'tsx'
              })
            )
          }
        }
      ]
    })
    const { TvBrowser, nativeViews } = require(outfile)
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    let fail = false
    const team = asTeamSummary({
      id: 'team',
      name: 'Demo Hawks',
      shortName: null,
      logoPath: null,
      logoUrl: null
    })
    const client = {
      videoGames: async () => [],
      videoTeams: async (options: any) => {
        if (fail) throw new Error('Offline')
        return typeof options?.q === 'string' ? [team] : []
      },
      videoPlayers: async () => [],
      me: async () => ({ guardians: [] })
    }
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 600))
      })
    }
    try {
      await act(async () => {
        root.render(
          React.createElement(TvBrowser, {
            client,
            viewerName: 'Viewer',
            onPlay: () => undefined,
            onSignOut: () => undefined
          })
        )
      })
      expect(
        element.querySelector('[data-testid="tv-search-label"]')?.textContent
      ).equals('Search')
      await act(async () => {
        element.querySelector<HTMLElement>('[data-testid="tv-search"]')!.click()
      })
      await act(async () => {
        nativeViews.get('TVSearch').onQuery({ nativeEvent: { query: 'Hawks' } })
      })
      await settle()
      expect(nativeViews.get('TVSearch').items[0].title).equals('Demo Hawks')
      await act(async () => {
        nativeViews
          .get('TVSearch')
          .onSelect({ nativeEvent: { id: 'team:team' } })
      })
      expect(element.textContent).contains('Demo Hawks')
      await act(async () => {
        element.querySelector<HTMLElement>('[data-testid="tv-search"]')!.click()
      })
      fail = true
      await act(async () => {
        nativeViews.get('TVSearch').onQuery({ nativeEvent: { query: 'Retry' } })
      })
      await settle()
      expect(nativeViews.get('TVSearch').items[0].id).equals('retry')
      fail = false
      await act(async () => {
        nativeViews.get('TVSearch').onSelect({ nativeEvent: { id: 'retry' } })
      })
      await settle()
      expect(nativeViews.get('TVSearch').items[0].id).equals('team:team')
      await act(async () => {
        nativeViews.get('TVSearch').onDismiss()
      })
      expect(
        element.querySelector('[data-testid="tv-search-label"]')?.textContent
      ).equals('Search')
      expect(element.querySelector('[data-testid="TVSearch"]')).equals(null)
    } finally {
      await act(async () => {
        root.unmount()
      })
      element.remove()
    }
  })
})
