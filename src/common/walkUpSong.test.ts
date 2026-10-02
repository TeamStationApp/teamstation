import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asWalkUpSong, formatClip, type WalkUpSong } from './walkUpSong'

const centerfield: WalkUpSong = {
  provider: 'appleMusic',
  providerId: '1440857781',
  isrc: 'USFI86900049',
  title: 'Centerfield',
  artist: 'John Fogerty',
  album: 'Centerfield',
  artworkUrl: 'https://is1-ssl.mzstatic.com/image/600x600bb.jpg',
  durationMs: 230000,
  startMs: 10000,
  endMs: 25000
}

const refuses = (change: Record<string, unknown>, reason: RegExp): void => {
  expect(() => asWalkUpSong({ ...centerfield, ...change })).throws(
    TypeError,
    reason
  )
}

describe('asWalkUpSong', function () {
  it('reads a whole song as it is', function () {
    expect(asWalkUpSong(centerfield)).deep.equals(centerfield)
  })

  it('reads a local file with the fewest fields, and trims text', function () {
    expect(
      asWalkUpSong({
        provider: 'localFile',
        providerId: 'lf:0123456789abcdef',
        title: '  Walkup Fixture ',
        artist: 'TeamStation',
        album: '',
        isrc: '  ',
        artworkUrl: null,
        durationMs: 90000,
        startMs: 0,
        endMs: 1000
      })
    ).deep.equals({
      provider: 'localFile',
      providerId: 'lf:0123456789abcdef',
      isrc: null,
      title: 'Walkup Fixture',
      artist: 'TeamStation',
      album: null,
      artworkUrl: null,
      durationMs: 90000,
      startMs: 0,
      endMs: 1000
    })
  })

  it('reads an ISRC without hyphens and in capitals', function () {
    expect(
      asWalkUpSong({ ...centerfield, isrc: 'us-fi8-69-00049' }).isrc
    ).equals('USFI86900049')
    refuses({ isrc: 'USFI8690004' }, /isrc/)
    refuses({ isrc: 12 }, /isrc/)
  })

  it('refuses anything that is not an object', function () {
    for (const raw of [null, undefined, 'song', 3, []]) {
      expect(() => asWalkUpSong(raw)).throws(TypeError, /object/)
    }
  })

  it('holds the provider and its id to their rules', function () {
    refuses({ provider: 'spotify' }, /provider/)
    refuses({ providerId: '' }, /providerId/)
    refuses({ providerId: 'x'.repeat(201) }, /providerId/)
    refuses({ providerId: 'lf:0123456789abcdef' }, /Apple Music/)
    refuses(
      { provider: 'localFile', providerId: '1440857781' },
      /lf: and 16 hex/
    )
    refuses(
      { provider: 'localFile', providerId: 'lf:0123456789ABCDEF' },
      /lf: and 16 hex/
    )
  })

  it('needs a title and an artist, and bounds every text', function () {
    refuses({ title: ' ' }, /title: Must not be empty/)
    refuses({ artist: undefined }, /artist: Expected text/)
    refuses({ title: 'x'.repeat(301) }, /title: At most 300/)
    refuses({ album: 7 }, /album/)
    expect(
      asWalkUpSong({ ...centerfield, title: 'x'.repeat(300) }).title
    ).length(300)
  })

  it('takes only an http or https artwork address', function () {
    refuses({ artworkUrl: 'file:///tmp/art.jpg' }, /artworkUrl/)
    expect(
      asWalkUpSong({ ...centerfield, artworkUrl: 'http://example.com/a.jpg' })
        .artworkUrl
    ).equals('http://example.com/a.jpg')
  })

  it('bounds the song and the clip', function () {
    refuses({ durationMs: 0 }, /durationMs: Out of range/)
    refuses({ durationMs: 24 * 3600 * 1000 + 1 }, /durationMs/)
    refuses({ durationMs: 1.5 }, /whole number/)
    refuses({ durationMs: '230000' }, /whole number/)
    refuses({ startMs: -1 }, /startMs/)
    refuses({ startMs: 25000 }, /endMs: Must be after/)
    refuses({ endMs: 230001, startMs: 229000 }, /within the song/)
    // One second to one minute, both ends included.
    refuses({ endMs: 10999 }, /1 to 60 seconds/)
    refuses({ endMs: 70001 }, /1 to 60 seconds/)
    expect(asWalkUpSong({ ...centerfield, endMs: 11000 }).endMs).equals(11000)
    expect(asWalkUpSong({ ...centerfield, endMs: 70000 }).endMs).equals(70000)
    expect(
      asWalkUpSong({ ...centerfield, startMs: 170000, endMs: 230000 }).endMs
    ).equals(230000)
  })
})

describe('formatClip', function () {
  it('writes the clip as minutes and seconds', function () {
    expect(formatClip(centerfield)).equals('0:10–0:25')
    expect(formatClip({ startMs: 0, endMs: 59600 })).equals('0:00–1:00')
    expect(formatClip({ startMs: 65400, endMs: 125000 })).equals('1:05–2:05')
    expect(formatClip({ startMs: 3599000, endMs: 3659000 })).equals(
      '59:59–60:59'
    )
  })
})
