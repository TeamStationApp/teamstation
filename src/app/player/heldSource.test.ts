import { expect } from 'chai'
import { describe, it } from 'mocha'

import { heldSource } from './heldSource'

const URL = 'https://media.example.test/v1/index.m3u8'

describe("the game screen's player under the angles", function () {
  it('gives a phone no source while the angles are up', function () {
    for (const platform of ['android', 'ios']) {
      expect(heldSource(URL, { anglesUp: true, platform })).equals(null)
    }
  })

  it('keeps the address in a browser, whose detach already lets it go', function () {
    expect(heldSource(URL, { anglesUp: true, platform: 'web' })).equals(URL)
  })

  it('gives every platform its address once the angles are down', function () {
    for (const platform of ['android', 'ios', 'web']) {
      expect(heldSource(URL, { anglesUp: false, platform })).equals(URL)
    }
  })

  it('leaves no address as none', function () {
    expect(heldSource(null, { anglesUp: false, platform: 'android' })).equals(
      null
    )
    expect(heldSource(null, { anglesUp: true, platform: 'web' })).equals(null)
  })
})
