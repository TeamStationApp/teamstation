import { expect } from 'chai'
import { describe, it } from 'mocha'

import { verifyQueryToken } from './mediaTokens'
import { posterSecond, posterUrl } from './posters'
import { stillKey, stillSubject } from './stills'

describe('a game poster', function () {
  it('is a signed URL to the API for a still kept beside the video in the Space', function () {
    const media = {
      publicUrl: 'https://gamestation.co',
      mediaSecret: 'secret'
    } as unknown as Parameters<typeof posterUrl>[0]
    const url = new URL(posterUrl(media, 'vid_1', 150.4, Date.UTC(2026, 9, 2)))
    expect(url.origin + url.pathname).equals(
      'https://gamestation.co/api/v1/videos/vid_1/stills/150.jpg'
    )
    const token = url.searchParams.get('t')
    expect(
      verifyQueryToken(
        'secret',
        stillSubject('vid_1'),
        token,
        Date.UTC(2026, 9, 2)
      )
    ).equals(true)
    expect(
      verifyQueryToken(
        'secret',
        stillSubject('vid_2'),
        token,
        Date.UTC(2026, 9, 2)
      )
    ).equals(false)
    expect(stillKey('vid_1', 150.4)).equals('videos/vid_1/stills/150.jpg')
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
