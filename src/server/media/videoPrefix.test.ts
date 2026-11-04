import { expect } from 'chai'
import { describe, it } from 'mocha'

import { spaceKey } from './spacesHls'
import { stillKey } from './stills'
import {
  isSecretKeyOf,
  isSpaceSecret,
  newSpaceSecret,
  oldVideoPrefix,
  uploadHeadersFor,
  videoKey,
  videoPrefix
} from './videoPrefix'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('a video’s prefix in the Space', function () {
  it('is videos/<id>-<secret>/ with a secret, and videos/<id>/ without', function () {
    expect(videoPrefix({ id: 'vid_abc', spaceSecret: SECRET })).equals(
      `videos/vid_abc-${SECRET}/`
    )
    expect(videoPrefix({ id: 'vid_abc', spaceSecret: null })).equals(
      'videos/vid_abc/'
    )
    expect(oldVideoPrefix('vid_abc')).equals('videos/vid_abc/')
    expect(videoKey({ id: 'vid_abc', spaceSecret: SECRET }, 'init.mp4')).equals(
      `videos/vid_abc-${SECRET}/init.mp4`
    )
    expect(
      spaceKey({ id: 'vid_abc', spaceSecret: SECRET }, 'video.mp4')
    ).equals(`videos/vid_abc-${SECRET}/video.mp4`)
  })

  it('refuses a secret that is not 32 lowercase hex characters', function () {
    for (const bad of ['', 'abc', SECRET.toUpperCase(), `${SECRET}0`, '../x'])
      expect(() => videoPrefix({ id: 'vid_abc', spaceSecret: bad })).throws(
        'Invalid video space secret'
      )
  })

  it('makes a new 128-bit secret every time', function () {
    const made = new Set(Array.from({ length: 200 }, () => newSpaceSecret()))
    expect(made.size).equals(200)
    for (const secret of made) expect(isSpaceSecret(secret)).equals(true)
    expect(isSpaceSecret(null)).equals(false)
  })

  it('keeps stills at videos/<id>/stills/, whatever the secret', function () {
    expect(stillKey('vid_abc', 12.4)).equals('videos/vid_abc/stills/12.jpg')
  })

  it('knows a key under this video’s secret prefix from another video’s', function () {
    expect(
      isSecretKeyOf('vid_a', `videos/vid_a-${SECRET}/seg000000.m4s`)
    ).equals(true)
    // An id that starts with this one's, with or without a secret of its own.
    expect(
      isSecretKeyOf('vid_a', `videos/vid_a-b-${SECRET}/seg000000.m4s`)
    ).equals(false)
    expect(isSecretKeyOf('vid_a', 'videos/vid_a-b/seg000000.m4s')).equals(false)
    expect(isSecretKeyOf('vid_a', 'videos/vid_a/seg000000.m4s')).equals(false)
    expect(isSecretKeyOf('vid_a', `images/vid_a-${SECRET}/x`)).equals(false)
  })

  it('makes pieces and recordings public for 600 s, init files for 60 s, and nothing else public', function () {
    const piece = { acl: 'public-read', cacheControl: 'public, max-age=600' }
    expect(uploadHeadersFor(SECRET, 'seg000042.m4s')).deep.equals(piece)
    expect(uploadHeadersFor(SECRET, 'seg1000000.m4s')).deep.equals(piece)
    expect(uploadHeadersFor(SECRET, 'video.mp4')).deep.equals(piece)
    expect(uploadHeadersFor(SECRET, 'init.mp4')).deep.equals({
      acl: 'public-read',
      cacheControl: 'public, max-age=60'
    })
    expect(uploadHeadersFor(SECRET, 'init_1.mp4')).deep.equals({
      acl: 'public-read',
      cacheControl: 'public, max-age=60'
    })
    for (const name of ['index.m3u8', 'master.m3u8', 'video.m3u8', '10.jpg'])
      expect(uploadHeadersFor(SECRET, name), name).deep.equals({})
    // A video with no secret is on a path that holds only its id: private.
    for (const name of ['seg000042.m4s', 'video.mp4', 'init.mp4'])
      expect(uploadHeadersFor(null, name), name).deep.equals({})
  })
})
