import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import sdk from '../assets/leafletRuntime.json'
import { eventMapDocument } from './eventMapDocument'

describe('bundled event mapping SDK', () => {
  it('matches the pinned package and keeps attribution, marker and navigation', () => {
    const root = dirname(require.resolve('leaflet/package.json'))
    expect(sdk.js).equals(readFileSync(join(root, 'dist/leaflet.js'), 'utf8'))
    expect(sdk.css).equals(readFileSync(join(root, 'dist/leaflet.css'), 'utf8'))
    const html = eventMapDocument({
      latitude: 0,
      longitude: 0,
      tileUrl: 'https://example.test/{z}/{x}/{y}.png'
    })
    expect(html)
      .includes('L.map')
      .and.includes('L.marker')
      .and.includes('OpenStreetMap')
      .and.includes('tileerror')
    expect(html).includes('window.eventMapCenter')
  })
  it('rejects missing/invalid coordinates and escapes settings from HTML/script context', () => {
    for (const latitude of [null, Infinity, 91])
      expect(() =>
        eventMapDocument({ latitude, longitude: 0, tileUrl: '' })
      ).throws()
    expect(() =>
      eventMapDocument({ latitude: 0, longitude: null, tileUrl: '' })
    ).throws()
    expect(() =>
      eventMapDocument({ latitude: 0, longitude: 181, tileUrl: '' })
    ).throws()
    const html = eventMapDocument({
      latitude: 34,
      longitude: 12,
      tileUrl: '</script><script>alert(1)</script>'
    })
    expect(html).not.includes('"tileUrl":"</script>')
    expect(html).includes('\\u003c/script>')
  })
})
