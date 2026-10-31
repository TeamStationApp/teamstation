import path from 'node:path'

import { expect } from 'chai'
import { buildSync } from 'esbuild'
import { describe, it } from 'mocha'

/** Exercise the JS/native prop boundary; UIKit itself is covered by XCTest. */
describe('TV native presentation bridge', () => {
  it('registers native views and forwards poster and search props without web markup', () => {
    const outfile = path.resolve('lib/tv-native-presentation.cjs')
    buildSync({
      entryPoints: ['src/app/tv/NativePresentation.tsx'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      sourcemap: true,
      external: ['react'],
      alias: {
        'react-native': path.resolve('src/test/tvNativePresentationStub.ts')
      }
    })
    // The isolated module models the native runtime, separate from the web bundle.
    const bridge = require(outfile)
    expect(bridge.nativeTvPresentation).equals(true)
    expect(bridge.NativeSearch).equals('TVSearch')
    expect(bridge.NativeGradient).equals('TVGradient')
    const poster = bridge.TvPoster({
      uri: 'https://example.test/poster.jpg',
      focused: true,
      children: 'moving preview'
    })
    expect(poster.type).equals('TVPoster')
    expect(poster.props.previewFocused).equals(true)
    expect(poster.props.children).equals('moving preview')
    expect(poster.props.uri).equals('https://example.test/poster.jpg')
    expect(poster.props.pointerEvents).equals('none')
    expect(poster.props.style).deep.equals({ position: 'absolute' })
  })
})
