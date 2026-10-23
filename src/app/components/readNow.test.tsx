import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import { Platform } from 'react-native'

import { readNow } from './readNow'

describe('reading animated values now', function () {
  const originalOS = Platform.OS
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', {
      value: originalOS,
      configurable: true
    })
  })

  it('reads on the one thread a browser has', function () {
    expect(readNow(() => 7)).equals(7)
  })

  it('reads on the animation thread on a phone', function () {
    Object.defineProperty(Platform, 'OS', {
      value: 'android',
      configurable: true
    })
    // The tests run the web build of worklets, which has no animation thread
    // and refuses the read there: the read went to it, not to this thread.
    let read = false
    expect(() =>
      readNow(() => {
        read = true
        return 7
      })
    ).throws(/runOnUISync/)
    expect(read).equals(false)
  })
})
