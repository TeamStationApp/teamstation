import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { WalkUpSong } from '../../common/walkUpSong'
import { matchSong, normaliseSongText } from './songMatch'
import type { SongCandidate } from './walkUpMusicTypes'

const saved: WalkUpSong = {
  provider: 'appleMusic',
  providerId: '1440833098',
  isrc: 'USFI88500001',
  title: 'Centerfield',
  artist: 'John Fogerty',
  album: 'Centerfield',
  artworkUrl: null,
  durationMs: 233000,
  startMs: 10000,
  endMs: 25000
}

function candidate(fields: Partial<SongCandidate>): SongCandidate {
  return {
    provider: 'localFile',
    providerId: 'lf:0000000000000000',
    isrc: null,
    title: 'Other',
    artist: 'Somebody',
    album: null,
    artworkUrl: null,
    durationMs: 100000,
    source: 'device',
    handle: 'content://media/1',
    ...fields
  }
}

describe('normaliseSongText', function () {
  it('drops brackets, accents and a featured artist', function () {
    expect(normaliseSongText('Centerfield (Remastered 2010)')).equals(
      'centerfield'
    )
    expect(normaliseSongText('Crazy Train [Live]')).equals('crazy train')
    expect(normaliseSongText('Mötley Crüe')).equals('motley crue')
    expect(normaliseSongText('Señorita')).equals('senorita')
    expect(normaliseSongText('Old Town Road feat. Billy Ray Cyrus')).equals(
      'old town road'
    )
    expect(normaliseSongText('Lil Nas X ft. Billy Ray Cyrus')).equals(
      'lil nas x'
    )
    expect(normaliseSongText('Eminem featuring Nobody')).equals('eminem')
  })

  it('keeps words that merely contain feat or ft, and reads & as and', function () {
    expect(normaliseSongText('Defeat the Left Foot')).equals(
      'defeat the left foot'
    )
    expect(normaliseSongText('Simon & Garfunkel')).equals('simon and garfunkel')
    expect(normaliseSongText('  AC/DC!! ')).equals('ac dc')
  })
})

describe('matchSong', function () {
  it('takes the same provider id first', function () {
    const byId = candidate({ providerId: '1440833098', title: 'Wrong' })
    const byTitle = candidate({
      title: 'Centerfield',
      artist: 'John Fogerty',
      durationMs: 233000
    })
    expect(matchSong(saved, [byTitle, byId])).equals(byId)
  })

  it('lets an ISRC win over a title', function () {
    const byTitle = candidate({
      title: 'Centerfield',
      artist: 'John Fogerty',
      durationMs: 233000,
      handle: 'title'
    })
    const byIsrc = candidate({ isrc: 'usfi88500001', handle: 'isrc' })
    expect(matchSong(saved, [byTitle, byIsrc])).equals(byIsrc)
  })

  it('matches the normalised title and artist within 2 s, not 2.1 s', function () {
    const near = candidate({
      title: 'Centerfield (2010 Remaster)',
      artist: 'JOHN FOGERTY',
      durationMs: 235000
    })
    expect(matchSong({ ...saved, isrc: null }, [near])).equals(near)
    const far = { ...near, durationMs: 235100 }
    expect(matchSong({ ...saved, isrc: null }, [far])).equals(null)
    const early = { ...near, durationMs: 231000 }
    expect(matchSong({ ...saved, isrc: null }, [early])).equals(early)
  })

  it('gives null for no candidates, and for strangers', function () {
    expect(matchSong(saved, [])).equals(null)
    expect(matchSong(saved, [candidate({})])).equals(null)
  })
})
