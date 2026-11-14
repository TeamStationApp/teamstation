import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect } from 'chai'
import { build } from 'esbuild'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

describe('TV native panel gradient', () => {
  it('uses the same bounds-backed right gradient on initial mounting and reopening', async () => {
    const { webSettings } = require('../../scripts/web-build-settings.mjs')
    const outfile = path.resolve('lib/tv-panel-gradient-native.cjs')
    await build({
      ...webSettings,
      stdin: {
        contents:
          "export { PanelGradient } from './src/app/tv/TvPlayer'; export { nativeViews } from './src/test/tvBrowserNativeRuntime'",
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
          name: 'native-gradient-test',
          setup(builder: any) {
            builder.onLoad(
              { filter: /app\/tv\/TvPlayer\.tsx$/ },
              (args: any) => ({
                contents:
                  readFileSync(args.path, 'utf8') +
                  '\nexport { PanelGradient }',
                loader: 'tsx'
              })
            )
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
    const { PanelGradient, nativeViews } = require(outfile)
    const element = document.createElement('div')
    const root = createRoot(element)
    try {
      for (const key of ['clip-completion', 'manual-open']) {
        await act(async () => {
          root.render(
            React.createElement(PanelGradient, {
              key,
              direction: 'right',
              maxOpacity: 0.6
            })
          )
        })
        const gradient = nativeViews.get('TVGradient')
        expect(gradient.gradientDirection).equals('right')
        expect(gradient.maxOpacity).equals(0.6)
        expect(gradient.style).includes({
          top: 0,
          bottom: 0,
          left: 0,
          right: 0
        })
        expect(element.querySelector('svg')).equals(null)
        await act(async () => {
          root.render(null)
        })
      }
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
  })
})
