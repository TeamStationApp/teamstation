import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { markerProps, nativeMapProps } from '../../test/eventNativeMapStub'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import { mapDocumentOf } from '../../test/mapFrameDom'
import { PinMap } from './PinMap'
import { PinMap as AndroidPinMap } from './PinMap.android'
import { PinMap as IosPinMap } from './PinMap.native'
import { pinMovedOf } from './pinMapDocument'

const settings = {
  latitude: 40.02,
  longitude: -75.22,
  googleMapsApiKey: 'placeholder-key',
  editable: true
}

const nativeMap = (): Element | null =>
  document.querySelector('[data-testid="native-google-map"]')

describe('the pin map', () => {
  afterEach(unmount)

  it('reads only a well-formed moved pin', () => {
    const moved = { type: 'teamstation:pinMoved', latitude: 1, longitude: 2 }
    expect(pinMovedOf(moved)).deep.equals(moved)
    expect(pinMovedOf(JSON.stringify(moved))).deep.equals(moved)
    for (const bad of [
      'not json',
      null,
      7,
      { ...moved, type: 'other' },
      { ...moved, latitude: 'north' },
      { ...moved, latitude: 91 },
      { ...moved, longitude: Infinity }
    ])
      expect(pinMovedOf(bad), JSON.stringify(bad)).equals(undefined)
  })

  it('frames Google’s map on the web, and takes moves only from its own frame', async () => {
    const moves: unknown[] = []
    await mount(<PinMap settings={settings} onMove={pin => moves.push(pin)} />)
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-testid="pin-map"]'
    )!
    const html = mapDocumentOf(frame)
    expect(html).includes('Field location map')
    expect(html).includes('https://maps.googleapis.com/maps/api/js?')
    expect(html).includes('"editable":true')
    expect(html.toLowerCase()).not.includes('leaflet')
    expect(html.toLowerCase()).not.includes('openstreetmap')
    const post = (source: unknown, data: unknown): void => {
      const event = new window.Event('message')
      Object.defineProperties(event, {
        data: { value: data },
        source: { value: source }
      })
      window.dispatchEvent(event)
    }
    const data = { type: 'teamstation:pinMoved', latitude: 1, longitude: 2 }
    post(window, data)
    post(null, data)
    post(frame.contentWindow, { type: 'other' })
    post(frame.contentWindow, data)
    await settle(0)
    expect(moves).deep.equals([{ latitude: 1, longitude: 2 }])
  })

  it('frames the "couldn’t load" panel on the web when there is no key', async () => {
    await mount(
      <PinMap settings={{ ...settings, googleMapsApiKey: undefined }} />
    )
    const html = mapDocumentOf(
      document.querySelector('iframe[data-testid="pin-map"]')
    )
    expect(html).includes('The map couldn’t load')
    expect(html).includes('40.02000, -75.22000')
    expect(html).includes('>Retry</button>')
  })

  it('draws Apple Maps on iOS: no provider, hybrid, and a pin that drags when editable', async () => {
    const moves: unknown[] = []
    await mount(
      <IosPinMap settings={settings} onMove={pin => moves.push(pin)} />
    )
    expect(nativeMap()).not.equals(null)
    // No provider is MapKit on iOS; Google's SDK is never linked there.
    expect(nativeMapProps.provider).equals(undefined)
    expect(nativeMapProps.mapType).equals('hybrid')
    expect(markerProps.draggable).equals(true)
    markerProps.onDragEnd?.({
      nativeEvent: { coordinate: { latitude: 3, longitude: 4 } }
    })
    expect(moves).deep.equals([{ latitude: 3, longitude: 4 }])
    expect(document.querySelector('iframe')).equals(null)
    await unmount()
    // Read-only, as the venue screen shows it, and with nobody to tell.
    await mount(<IosPinMap settings={{ ...settings, editable: false }} />)
    expect(nativeMapProps.provider).equals(undefined)
    expect(markerProps.draggable).equals(false)
    markerProps.onDragEnd?.({
      nativeEvent: { coordinate: { latitude: 5, longitude: 6 } }
    })
  })

  it('drags the Android marker on Google, and shows the panel with Retry when Google does not draw', async () => {
    const moves: unknown[] = []
    await mount(
      <AndroidPinMap
        settings={settings}
        onMove={pin => moves.push(pin)}
        fallbackAfterMs={50}
      />
    )
    expect(nativeMapProps.provider).equals('google')
    expect(markerProps.draggable).equals(true)
    markerProps.onDragEnd?.({
      nativeEvent: { coordinate: { latitude: 5, longitude: 6 } }
    })
    expect(moves).deep.equals([{ latitude: 5, longitude: 6 }])
    await settle(120)
    expect(nativeMap()).equals(null)
    expect(
      document.querySelector('[data-testid="pin-map-unavailable"]')
    ).not.equals(null)
    expect(text()).includes('The map couldn’t load')
    expect(text()).includes('40.02000, -75.22000')
    // Retry gives Google's map another try, which draws this time.
    await press('Retry')
    expect(nativeMap()).not.equals(null)
    nativeMapProps.onMapLoaded?.()
    await settle(120)
    expect(nativeMap()).not.equals(null)
    await unmount()
    await mount(
      <AndroidPinMap
        settings={{ ...settings, editable: false }}
        fallbackAfterMs={1000}
      />
    )
    nativeMapProps.onMapLoaded?.()
    await settle(1100)
    expect(markerProps.draggable).equals(false)
    expect(nativeMap()).not.equals(null)
    markerProps.onDragEnd?.({
      nativeEvent: { coordinate: { latitude: 7, longitude: 8 } }
    })
  })
})
