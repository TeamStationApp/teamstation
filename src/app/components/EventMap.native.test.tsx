import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Linking } from 'react-native'

import { webViewProps } from '../../test/eventWebViewStub'
import { EventMap } from './EventMap.native'

let root: Root | undefined
const original = Linking.openURL.bind(Linking)
afterEach(async () => {
  await act(async () => root?.unmount())
  Linking.openURL = original
  document.body.replaceChildren()
})
describe('native event map adapter', () => {
  it('renders the shared SDK document, identifies tile requests and restricts navigation', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <EventMap
          location={{
            latitude: 34,
            longitude: 12,
            tileUrl: 'https://example.test/{z}/{x}/{y}'
          }}
        />
      )
    })
    expect(webViewProps.source?.html).includes('L.map')
    expect(webViewProps.userAgent).equals('TeamStation/1.0')
    const opened: string[] = []
    Linking.openURL = async url => {
      opened.push(url)
    }
    const navigate = webViewProps.onShouldStartLoadWithRequest!
    expect(navigate({ url: 'about:blank' })).equals(true)
    expect(navigate({ url: 'https://app.teamstation.app/' })).equals(true)
    expect(navigate({ url: 'https://example.test' })).equals(false)
    expect(navigate({ url: 'https://www.openstreetmap.org/copyright' })).equals(
      false
    )
    expect(opened).deep.equals(['https://www.openstreetmap.org/copyright'])
    Linking.openURL = async () => {
      throw new Error('cannot open browser')
    }
    expect(navigate({ url: 'https://www.openstreetmap.org/copyright' })).equals(
      false
    )
    await act(async () => {
      await Promise.resolve()
    })
  })
})
