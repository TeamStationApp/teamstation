import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import { Linking } from 'react-native'

import { clipboardTest } from '../../test/eventClipboardStub'
import { copyEventAddress, openEventDirections } from './eventDirections.native'

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
})
