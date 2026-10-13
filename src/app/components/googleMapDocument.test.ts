import { expect } from 'chai'
import { describe, it } from 'mocha'

import { googleMapDocument } from './googleMapDocument'

describe('Google Maps browser document', () => {
  it('encodes settings as data and uses the draggable SDK with authentication recovery', () => {
    const html = googleMapDocument({
      latitude: 34,
      longitude: 12,
      tileUrl: '',
      googleMapsApiKey: '</script>example'
    })
    expect(html)
      .includes('importLibrary')
      .and.includes('AdvancedMarkerElement')
      .and.includes("gestureHandling:'greedy'")
      .and.includes('gm_authFailure')
    expect(html).not.includes('</script>example')
    expect(html).includes('\\u003c/script>example')
  })
  it('rejects missing credentials or invalid coordinates before loading the SDK', () => {
    expect(() =>
      googleMapDocument({ latitude: 34, longitude: 12, tileUrl: '' })
    ).throws('not configured')
    expect(() =>
      googleMapDocument({
        latitude: 100,
        longitude: 12,
        tileUrl: '',
        googleMapsApiKey: 'example'
      })
    ).throws('could not be located')
  })
})
