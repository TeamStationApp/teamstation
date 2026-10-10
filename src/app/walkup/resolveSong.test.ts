import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { WalkUpSong } from '../../common/walkUpSong'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { deviceLinks, deviceLinkStore, resolveSong } from './resolveSong'
import type { SongCandidate, WalkUpMusic } from './walkUpMusicTypes'

const song: WalkUpSong = {
  provider: 'localFile',
  providerId: 'lf:110f83a3e9419109',
  isrc: null,
  title: 'TS Walkup Fixture',
  artist: 'TeamStation Test',
  album: null,
  artworkUrl: null,
  durationMs: 90000,
  startMs: 5000,
  endMs: 20000
}
const owner = { teamId: 't1', userId: '7' }

function memory(): PreferenceStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: async key => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value)
    }
  }
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
    durationMs: 90000,
    source: 'device',
    handle: 'content://media/other',
    ...fields
  }
}

function music(
  search: (term: string) => Promise<SongCandidate[]>
): WalkUpMusic & { terms: string[] } {
  const terms: string[] = []
  return {
    available: true,
    djSupported: false,
    providerName: 'This phone',
    access: async () => 'authorized',
    search: async term => {
      terms.push(term)
      return await search(term)
    },
    pickFile: async () => null,
    play: async () => undefined,
    stop: async () => undefined,
    onState: () => () => undefined,
    terms
  }
}

describe('resolveSong', function () {
  it('takes this phone’s device link before searching', async function () {
    const storage = memory()
    const links = deviceLinkStore(storage)
    await links.write(owner, song.providerId, 'content://picked/1')
    expect([...storage.items.keys()]).deep.equals([
      'walkUp:t1:7:lf:110f83a3e9419109'
    ])
    const phone = music(async () => [])
    expect(await resolveSong(phone, song, owner, links)).equals(
      'content://picked/1'
    )
    expect(phone.terms).deep.equals([])
  })

  it('then the provider id, the ISRC and the title, in that order', async function () {
    const links = deviceLinkStore(memory())
    const byTitle = candidate({
      title: 'TS Walkup Fixture',
      artist: 'TeamStation Test',
      handle: 'title'
    })
    const byId = candidate({ providerId: song.providerId, handle: 'id' })
    const phone = music(async () => [byTitle, byId])
    expect(await resolveSong(phone, song, owner, links)).equals('id')
    expect(phone.terms).deep.equals(['ts walkup fixture teamstation test'])

    const apple: WalkUpSong = {
      ...song,
      provider: 'appleMusic',
      providerId: '1440833098',
      isrc: 'USFI88500001'
    }
    const byIsrc = candidate({ isrc: 'USFI88500001', handle: 'isrc' })
    expect(
      await resolveSong(
        music(async () => [byTitle, byIsrc]),
        apple,
        owner,
        links
      )
    ).equals('isrc')
    expect(
      await resolveSong(
        music(async () => [byTitle]),
        apple,
        owner,
        links
      )
    ).equals('title')
    expect(
      await resolveSong(
        music(async () => []),
        apple,
        null,
        links
      )
    ).equals(null)
  })

  it('reads a failed search, or a failed link read, as not here', async function () {
    const failing: PreferenceStorage = {
      getItem: async () => {
        throw new Error('no storage')
      },
      setItem: async () => undefined
    }
    const phone = music(async () => {
      throw new Error('denied')
    })
    expect(
      await resolveSong(phone, song, owner, deviceLinkStore(failing))
    ).equals(null)
  })

  it('searches for the title alone when normalising leaves nothing', async function () {
    const phone = music(async () => [])
    await resolveSong(
      phone,
      { ...song, title: '!!', artist: '??' },
      null,
      deviceLinkStore(memory())
    )
    expect(phone.terms).deep.equals(['!!'])
  })
})

describe('deviceLinks, in this browser', function () {
  // The server's test run has no DOM, and the app's has jsdom's: each gets a
  // window of its own here, and its own back afterwards.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const use = (value: unknown): void => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value })
  }
  afterEach(function () {
    if (had == null) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', had)
  })

  it('keeps links in localStorage, and reads a refusal as none', async function () {
    const items = new Map<string, string>()
    use({
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value)
      }
    })
    await deviceLinks.write(owner, 'lf:1', 'content://1')
    expect(await deviceLinks.read(owner, 'lf:1')).equals('content://1')
    expect(await deviceLinks.read(owner, 'lf:2')).equals(null)
    const refuse = (): never => {
      throw new Error('private')
    }
    use({ localStorage: { getItem: refuse, setItem: refuse } })
    expect(await deviceLinks.read(owner, 'lf:1')).equals(null)
    await deviceLinks.write(owner, 'lf:1', 'content://1')
  })
})
