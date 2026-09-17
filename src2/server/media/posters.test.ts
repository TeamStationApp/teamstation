import { expect } from 'chai'
import { describe, it } from 'mocha'

import { stillDirFor } from './posters'

describe('a game poster', function () {
  it('takes its frames from the video own still directory', function () {
    expect(stillDirFor('vid_1')).equals('work/stills/vid_1')
  })
})
