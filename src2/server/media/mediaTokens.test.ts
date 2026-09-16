import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  MEDIA_TOKEN_TTL_SEC,
  mediaUrlPath,
  parseMediaPath,
  signMediaDir,
  verifyMediaPath
} from './mediaTokens'

const SECRET = 'a-test-secret'
const NOW = 1_760_000_000_000
const DIR = 'work/videos/vid_abc'

describe('media tokens', function () {
  it('signs a directory and verifies its own URL', function () {
    const path = mediaUrlPath(SECRET, DIR, 'master.m3u8', NOW)
    const result = verifyMediaPath(SECRET, path, NOW)
    expect(result.ok).equals(true)
    if (!result.ok) return
    expect(result.media.dir).equals(DIR)
    expect(result.media.rest).equals('master.m3u8')
  })

  it('covers every file of the video with one token', function () {
    const { expires, sig } = signMediaDir(SECRET, DIR, NOW)
    for (const file of [
      'master.m3u8',
      'video.m3u8',
      'init.mp4',
      'seg000.m4s'
    ]) {
      const result = verifyMediaPath(
        SECRET,
        `/media/${expires}/${sig}/${DIR}/${file}`,
        NOW
      )
      expect(result.ok, file).equals(true)
    }
  })

  it('refuses a token minted for another video', function () {
    const { expires, sig } = signMediaDir(SECRET, DIR, NOW)
    const result = verifyMediaPath(
      SECRET,
      `/media/${expires}/${sig}/work/videos/vid_other/master.m3u8`,
      NOW
    )
    expect(result.ok).equals(false)
    if (result.ok) return
    expect(result.reason).equals('badSignature')
  })

  it('refuses a token signed with another secret', function () {
    const path = mediaUrlPath('some-other-secret', DIR, 'master.m3u8', NOW)
    const result = verifyMediaPath(SECRET, path, NOW)
    expect(result.ok).equals(false)
    if (result.ok) return
    expect(result.reason).equals('badSignature')
  })

  it('refuses an expired token', function () {
    const path = mediaUrlPath(SECRET, DIR, 'master.m3u8', NOW)
    const later = NOW + (MEDIA_TOKEN_TTL_SEC + 1) * 1000
    const result = verifyMediaPath(SECRET, path, later)
    expect(result.ok).equals(false)
    if (result.ok) return
    expect(result.reason).equals('expired')
  })

  it('accepts a token right up to its expiry and not after', function () {
    const { expires, sig } = signMediaDir(SECRET, DIR, NOW)
    const url = `/media/${expires}/${sig}/${DIR}/master.m3u8`
    expect(verifyMediaPath(SECRET, url, expires * 1000 - 1).ok).equals(true)
    expect(verifyMediaPath(SECRET, url, expires * 1000).ok).equals(false)
  })

  it('refuses a path that climbs out of its directory', function () {
    // Signed correctly for the directory it claims, so only the traversal
    // check can catch it.
    const { expires, sig } = signMediaDir(SECRET, DIR, NOW)
    const escapes = [
      `/media/${expires}/${sig}/${DIR}/../../../etc/passwd`,
      `/media/${expires}/${sig}/${DIR}/..%2f..%2fpasswd`.replace(/%2f/g, '/'),
      `/media/${expires}/${sig}/work/../../etc/master.m3u8`
    ]
    for (const path of escapes) {
      const result = verifyMediaPath(SECRET, path, NOW)
      expect(result.ok, path).equals(false)
      if (result.ok) continue
      expect(result.reason, path).equals('escapesDirectory')
    }
  })

  it('refuses a backslash, which is a separator to some clients', function () {
    const { expires, sig } = signMediaDir(SECRET, 'work\\videos', NOW)
    const result = verifyMediaPath(
      SECRET,
      `/media/${expires}/${sig}/work\\videos/master.m3u8`,
      NOW
    )
    expect(result.ok).equals(false)
    if (result.ok) return
    expect(result.reason).equals('escapesDirectory')
  })

  it('refuses anything that is not a media path at all', function () {
    for (const path of [
      '/media/master.m3u8',
      '/media/notanumber/sig/dir/file',
      '/api/v1/health',
      '/media/1760000000/sig+with+bad+chars/dir/file'
    ]) {
      const result = verifyMediaPath(SECRET, path, NOW)
      expect(result.ok, path).equals(false)
      if (result.ok) continue
      expect(result.reason, path).equals('malformed')
    }
  })

  it('keeps a nested directory whole, as PeerTube lays them out', function () {
    const deep = 'peertube/private/7ce9abcd/f2b5'
    const parsed = parseMediaPath(
      `/media/1760000000/sig/${deep}/f2b5-master.m3u8`
    )
    expect(parsed?.dir).equals(deep)
    expect(parsed?.rest).equals('f2b5-master.m3u8')
  })
})
