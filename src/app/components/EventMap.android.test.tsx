import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { EventLocation } from '../../common/eventInfo'
import { nativeMapProps } from '../../test/eventNativeMapStub'
import { webViewProps } from '../../test/eventWebViewStub'
import { EventMap } from './EventMap.android'

const location: EventLocation = {
  latitude: 34,
  longitude: 12,
  tileUrl: 'https://example.test/{z}/{x}/{y}',
  googleMapsApiKey: 'placeholder-key'
}
let root: Root
const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
const originalSet = global.setTimeout
const originalClear = global.clearTimeout
async function render(value = location): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <EventMap location={value} />
      </StrictMode>
    )
  })
}
describe('Android Google map with OSM fallback', () => {
  beforeEach(() => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    global.setTimeout = ((
      callback: () => void,
      delay: number,
      ...args: unknown[]
    ) => {
      if (delay !== 15000) return originalSet(callback, delay, ...args)
      const token = originalSet(() => undefined, 0)
      originalClear(token)
      timers.set(token, callback)
      return token
    }) as typeof setTimeout
    global.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      if (!timers.delete(timer)) originalClear(timer)
    }) as typeof clearTimeout
  })
  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    global.setTimeout = originalSet
    global.clearTimeout = originalClear
    timers.clear()
    document.body.replaceChildren()
  })
  it('keeps the native Google map after load and cancels its deadline in StrictMode', async () => {
    await render()
    expect(nativeMapProps.provider).equals('google')
    expect(timers.size).equals(1)
    await act(async () => {
      nativeMapProps.onMapLoaded!()
    })
    expect(timers.size).equals(0)
    expect(
      document.querySelector('[data-testid="native-google-map"]')
    ).not.equals(null)
  })
  it('falls back once after a missing or failed SDK load and ignores its late callback', async () => {
    await render()
    const old = nativeMapProps.onMapLoaded!
    await act(async () => {
      for (const callback of timers.values()) callback()
    })
    expect(document.querySelector('[data-testid="native-google-map"]')).equals(
      null
    )
    expect(webViewProps.source?.html)
      .includes('OpenStreetMap')
      .and.not.includes('window.initEventMap')
    await act(async () => {
      old()
    })
    expect(document.querySelector('[data-testid="native-google-map"]')).equals(
      null
    )
  })
  it('starts a new native map for a changed coordinate and cleans up the old deadline', async () => {
    await render()
    const old = nativeMapProps.onMapLoaded!
    await render({ ...location, latitude: 35 })
    expect(timers.size).equals(1)
    await act(async () => {
      old()
    })
    expect(timers.size).equals(1)
    await act(async () => {
      root.unmount()
    })
    expect(timers.size).equals(0)
  })
  it('refuses invalid coordinates before either provider renders', () => {
    for (const latitude of [null, Infinity, 91])
      expect(() => EventMap({ location: { ...location, latitude } })).throws(
        'could not be located'
      )
    expect(() =>
      EventMap({ location: { ...location, longitude: 181 } })
    ).throws('could not be located')
  })
})
