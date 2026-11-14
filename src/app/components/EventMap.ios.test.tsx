import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { EventLocation } from '../../common/eventInfo'
import { markerProps, nativeMapProps } from '../../test/eventNativeMapStub'
import { webViewProps } from '../../test/eventWebViewStub'
import { EventMap } from './EventMap.ios'

const location: EventLocation = {
  latitude: 32.73,
  longitude: -117.13,
  tileUrl: 'https://example.test/{z}/{x}/{y}',
  googleMapsApiKey: 'placeholder-key'
}
let root: Root
async function render(value = location): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <EventMap location={value} />
      </StrictMode>
    )
  })
}
describe('iOS Apple Maps event map', () => {
  beforeEach(() => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    document.body.replaceChildren()
  })
  it("draws the event's point in Apple Maps with a marker", async () => {
    await render()
    expect(nativeMapProps.provider).equals(undefined)
    expect(nativeMapProps.testID).equals('event-location-map')
    expect(nativeMapProps.accessibilityLabel).equals('Event location map')
    expect(nativeMapProps.initialRegion).deep.equals({
      latitude: 32.73,
      longitude: -117.13,
      latitudeDelta: 0.015,
      longitudeDelta: 0.015
    })
    expect(nativeMapProps.rotateEnabled).equals(false)
    expect(nativeMapProps.pitchEnabled).equals(false)
    expect(markerProps.coordinate).deep.equals({
      latitude: 32.73,
      longitude: -117.13
    })
    expect(markerProps.title).equals('Event location')
  })
  it('draws no Google WebView map even when a Google key is present', async () => {
    const before = webViewProps
    await render()
    expect(webViewProps).equals(before)
    expect(
      document.querySelector('[data-testid="native-google-map"]')
    ).not.equals(null)
  })
  it('re-centres on a moved event', async () => {
    await render()
    await render({ ...location, latitude: 33 })
    expect(nativeMapProps.initialRegion?.latitude).equals(33)
    expect(markerProps.coordinate?.latitude).equals(33)
  })
  it('refuses invalid coordinates', () => {
    expect(() =>
      EventMap({ location: { ...location, longitude: null } })
    ).throws('could not be located')
  })
})
