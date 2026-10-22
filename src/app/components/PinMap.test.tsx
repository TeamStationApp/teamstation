import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { markerProps, nativeMapProps } from '../../test/eventNativeMapStub'
import { webViewProps } from '../../test/eventWebViewStub'
import { mount, settle, unmount } from '../../test/gameFormDom'
import { PinMap } from './PinMap'
import { PinMap as AndroidPinMap } from './PinMap.android'
import { PinMap as NativePinMap } from './PinMap.native'
import {
  googlePinDocument,
  leafletPinDocument,
  pinMapDocument,
  pinMovedOf
} from './pinMapDocument'

const settings = {
  latitude: 40.02,
  longitude: -75.22,
  tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png',
  editable: true
}

describe('the pin map', () => {
  afterEach(unmount)

  it('draws Leaflet without a key and Google with one, each posting a dragged pin', () => {
    const leaflet = pinMapDocument(settings)
    expect(leaflet).includes('draggable:config.editable')
    expect(leaflet).includes('teamstation:pinMoved')
    expect(leaflet).includes('ReactNativeWebView')
    expect(leaflet).not.includes('maps.googleapis.com')
    const google = pinMapDocument({
      ...settings,
      googleMapsApiKey: 'placeholder-key'
    })
    expect(google).includes('gmpDraggable:config.editable')
    expect(google).includes('maps.googleapis.com/maps/api/js')
    // Leaflet stands by inside the Google document, for an auth failure.
    expect(google).includes('pin-marker')
    expect(() => googlePinDocument(settings)).throws('not configured')
    expect(() => leafletPinDocument({ ...settings, latitude: 91 })).throws(
      'could not be located'
    )
    // Untrusted text in the settings stays out of the markup.
    expect(
      leafletPinDocument({ ...settings, tileUrl: '</script><b>' })
    ).not.includes('</script><b>')
  })

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

  it('takes moves only from its own frame on the web', async () => {
    const moves: unknown[] = []
    await mount(<PinMap settings={settings} onMove={pin => moves.push(pin)} />)
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-testid="pin-map"]'
    )!
    expect(frame.getAttribute('srcdoc')).includes('Field location map')
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

  it('posts a move from the iOS WebView', async () => {
    const moves: unknown[] = []
    await mount(
      <NativePinMap settings={settings} onMove={pin => moves.push(pin)} />
    )
    expect(webViewProps.source?.html).includes('Field location map')
    webViewProps.onMessage?.({ nativeEvent: { data: 'junk' } })
    webViewProps.onMessage?.({
      nativeEvent: {
        data: JSON.stringify({
          type: 'teamstation:pinMoved',
          latitude: 3,
          longitude: 4
        })
      }
    })
    expect(moves).deep.equals([{ latitude: 3, longitude: 4 }])
    const navigate = webViewProps.onShouldStartLoadWithRequest!
    expect(navigate({ url: 'about:blank' })).equals(true)
    expect(navigate({ url: 'https://app.teamstation.app/x' })).equals(true)
    expect(navigate({ url: 'https://elsewhere.example.test/' })).equals(false)
    // A frame inside the map (Google's own) may load what it likes.
    expect(
      navigate({ url: 'https://elsewhere.example.test/', isTopFrame: false })
    ).equals(true)
    expect(navigate({ url: 'https://www.openstreetmap.org/copyright' })).equals(
      false
    )
  })

  it('drags the Android marker, and falls back to the WebView when Google does not draw', async () => {
    const moves: unknown[] = []
    await mount(
      <AndroidPinMap
        settings={settings}
        onMove={pin => moves.push(pin)}
        fallbackAfterMs={50}
      />
    )
    expect(markerProps.draggable).equals(true)
    markerProps.onDragEnd?.({
      nativeEvent: { coordinate: { latitude: 5, longitude: 6 } }
    })
    expect(moves).deep.equals([{ latitude: 5, longitude: 6 }])
    await settle(120)
    expect(
      document.querySelector('[data-testid="native-event-map-test"]')
    ).not.equals(null)
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
    expect(
      document.querySelector('[data-testid="native-google-map"]')
    ).not.equals(null)
  })
})
