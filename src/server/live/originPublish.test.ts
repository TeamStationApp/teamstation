import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isSegmentName, objectKey, publishedPlaylist } from './originPublish'

const header =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n'
const first = '#EXTINF:4.000000,\nseg000000.m4s\n'
const second = '#EXTINF:4.000000,\nseg000001.m4s\n'
const third =
  '#EXT-X-DISCONTINUITY\n#EXTINF:2.500000,\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:08.000Z\nseg000002.m4s\n'
const whole = header + first + second + third + '#EXT-X-ENDLIST\n'
const set = (...names: string[]): Set<string> => new Set(names)

describe('the published live playlist', function () {
  it('publishes only the unbroken acknowledged prefix', function () {
    expect(
      publishedPlaylist(whole, set('seg000000.m4s', 'seg000002.m4s'), set())
    ).equals(header + first)
    expect(publishedPlaylist(whole, set(), set())).equals(header)
    expect(
      publishedPlaylist(
        header + '#EXT-X-DISCONTINUITY-SEQUENCE:0\n' + first,
        set(),
        set()
      )
    ).equals(header + '#EXT-X-DISCONTINUITY-SEQUENCE:0\n')
    expect(
      publishedPlaylist(whole, set('seg000000.m4s', 'seg000001.m4s'), set())
    ).equals(header + first + second)
  })

  it('keeps discontinuity and program time with their segment, and closes only after all acknowledgements', function () {
    const all = set('seg000000.m4s', 'seg000001.m4s', 'seg000002.m4s')
    expect(publishedPlaylist(whole, all, set())).equals(whole)
    expect(
      publishedPlaylist(whole.replace('#EXT-X-ENDLIST\n', ''), all, all)
    ).equals(header + first + second + third)
    expect(
      publishedPlaylist(whole.replaceAll('\n', '\r\n'), all, set())
    ).equals(whole)
  })

  it('retains the previously exposed prefix while a restamped object awaits replacement', function () {
    const published = set('seg000000.m4s', 'seg000001.m4s')
    expect(publishedPlaylist(whole, set('seg000000.m4s'), published)).equals(
      header + first + second
    )
    expect(publishedPlaylist(whole, set(), published)).equals(
      header + first + second
    )
    expect(
      publishedPlaylist(
        whole,
        set('seg000000.m4s', 'seg000001.m4s', 'seg000002.m4s'),
        published
      )
    ).equals(whole)
    expect(() =>
      publishedPlaylist(header + first, set('seg000000.m4s'), published)
    ).throws('lost a published segment')
  })

  it('never exposes temporary or unexpected URIs, nor an empty end tag', function () {
    expect(publishedPlaylist(header + '#EXT-X-ENDLIST\n', set(), set())).equals(
      header
    )
    expect(
      publishedPlaylist(header + '\n' + first, set('seg000000.m4s'), set())
    ).equals(header + '\n' + first)
    for (const name of [
      'seg000000.m4s.tmp',
      'notes.txt',
      'https://elsewhere.example.test/seg000000.m4s'
    ]) {
      expect(() =>
        publishedPlaylist(header + '#EXTINF:4,\n' + name, set(name), set())
      ).throws('Invalid live segment URI')
    }
  })

  it('admits only final object names within the video prefix', function () {
    for (const name of [
      'init.mp4',
      'index.m3u8',
      'master.m3u8',
      'seg000001.m4s',
      'seg1000000.m4s'
    ])
      expect(objectKey('vid_one', name)).equals(`videos/vid_one/${name}`)
    for (const name of [
      'seg000001.m4s.tmp',
      'notes.txt',
      '../init.mp4',
      'seg1.m4s'
    ]) {
      expect(isSegmentName(name)).equals(false)
      expect(() => objectKey('vid_one', name)).throws(
        'Invalid live object name'
      )
    }
    expect(isSegmentName('seg000001.m4s')).equals(true)
    expect(() => objectKey('../vid_one', 'init.mp4')).throws(
      'Invalid live object name'
    )
  })
})
