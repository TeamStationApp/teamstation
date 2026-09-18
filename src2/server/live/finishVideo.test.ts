import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isLivePart } from './finishVideo'

describe('what a live stream leaves behind', function () {
  it('knows a segment from a recording', function () {
    expect(isLivePart('init.mp4')).equals(true)
    expect(isLivePart('seg000000.m4s')).equals(true)
    expect(isLivePart('seg123456.m4s')).equals(true)

    // The three files a recording is made of, which must survive the sweep of
    // the parts it was built from.
    expect(isLivePart('video.mp4')).equals(false)
    expect(isLivePart('video.m3u8')).equals(false)
    expect(isLivePart('master.m3u8')).equals(false)
  })
})
