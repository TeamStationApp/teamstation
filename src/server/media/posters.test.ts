import { expect } from 'chai'
import { describe, it } from 'mocha'

import { posterSecond, stillDirFor } from './posters'

describe('a game poster', function () {
  it('takes its frames from the video own still directory', function () {
    expect(stillDirFor('vid_1')).equals('work/stills/vid_1')
  })

  it('asks for the frame it cut, whatever the video is worth', function () {
    // Two and a half minutes in for anything long enough to have one.
    expect(posterSecond(3600)).equals(150)
    expect(posterSecond(301)).equals(150)
    // And the middle of anything shorter. The list's URL used to ask for 150
    // while the cutter cut the middle, so a four-minute video's picture was
    // filed where nobody looked for it.
    expect(posterSecond(240)).equals(120)
    expect(posterSecond(20)).equals(10)
    // Nothing known about the length: assume it is long enough.
    expect(posterSecond(null)).equals(150)
    expect(posterSecond(undefined)).equals(150)
  })
})
