import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import { Linking } from 'react-native'

import { clipboardTest } from '../../test/eventClipboardStub'
import {
  copyEventAddress,
  openEventDirections,
  openPointDirections
} from './eventDirections.native'

const original = Linking.openURL.bind(Linking)
afterEach(() => {
  Linking.openURL = original
  clipboardTest.fail = false
})
describe('native event directions and clipboard entry points', () => {
  it('passes the address to platform handlers and propagates clipboard errors', async () => {
    const opened: string[] = []
    Linking.openURL = async url => {
      opened.push(url)
    }
    await openEventDirections('1 Demo Way')
    expect(opened).deep.equals(['geo:0,0?q=1%20Demo%20Way'])
    await copyEventAddress('1 Demo Way')
    expect(clipboardTest.value).equals('1 Demo Way')
    clipboardTest.fail = true
    try {
      await copyEventAddress('1 Demo Way')
      expect.fail('must reject')
    } catch (error) {
      expect(String(error)).includes('Clipboard unavailable')
    }
  })
  it('routes to a point by its coordinates, logging each URL it opens in development', async () => {
    const opened: string[] = []
    Linking.openURL = async url => {
      opened.push(url)
      if (url.startsWith('geo:')) throw new Error('no installed handler')
    }
    const info = console.info
    const logged: unknown[] = []
    console.info = (...args: unknown[]) => {
      logged.push(...args)
    }
    try {
      await openPointDirections({
        latitude: 40.0212,
        longitude: -75.2191,
        label: 'Example Park · Field 1'
      })
    } finally {
      console.info = info
    }
    const geo = `geo:40.0212,-75.2191?q=40.0212,-75.2191(${encodeURIComponent('Example Park · Field 1')})`
    const web =
      'https://www.google.com/maps/dir/?api=1&destination=40.0212,-75.2191'
    expect(opened).deep.equals([geo, web])
    expect(logged).deep.equals(['[directions] ' + geo, '[directions] ' + web])
  })
})
