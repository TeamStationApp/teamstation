import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asCandidate,
  asPlaybackState,
  makeWalkUpMusic,
  type WalkUpMusicModule
} from './makeWalkUpMusic'
import { musicLog } from './musicLog'
import type {
  NativeSongCandidate,
  NativeWalkUpMusicState
} from './NativeWalkUpMusic'
import type { PlaybackState } from './walkUpMusicTypes'

const raw: NativeSongCandidate = {
  provider: 'localFile',
  providerId: 'lf:110f83a3e9419109',
  isrc: null,
  title: ' TS Walkup Fixture ',
  artist: 'TeamStation Test',
  album: '',
  artworkUrl: null,
  durationMs: 90000.4,
  source: 'device',
  handle: 'content://media/external/audio/media/31'
}

function fakeModule(
  overrides: Partial<WalkUpMusicModule> = {}
): WalkUpMusicModule & {
  calls: unknown[][]
  emit: (state: NativeWalkUpMusicState) => void
} {
  const calls: unknown[][] = []
  let listener:
    Parameters<WalkUpMusicModule['onWalkUpMusicState']>[0] | undefined
  return {
    calls,
    emit: state => {
      Promise.resolve(listener?.(state)).catch(() => undefined)
    },
    onWalkUpMusicState: handler => {
      listener = handler
      return { remove: () => undefined }
    },
    access: async () => 'authorized',
    search: async term => {
      calls.push(['search', term])
      return [raw]
    },
    pickFile: async () => null,
    play: async (...args) => {
      calls.push(['play', ...args])
    },
    stop: async fadeMs => {
      calls.push(['stop', fadeMs])
    },
    ...overrides
  }
}

describe('makeWalkUpMusic', function () {
  it('names the store for the platform', function () {
    expect(makeWalkUpMusic(fakeModule(), { platform: 'ios' })).includes({
      available: true,
      providerName: 'Apple Music'
    })
    expect(
      makeWalkUpMusic(fakeModule(), { platform: 'android' }).providerName
    ).equals('This phone')
  })

  it('answers access from the fixed list, and unavailable otherwise', async function () {
    for (const [answer, expected] of [
      ['authorized', 'authorized'],
      ['denied', 'denied'],
      ['restricted', 'restricted'],
      ['maybe', 'unavailable']
    ]) {
      const music = makeWalkUpMusic(
        fakeModule({ access: async () => answer }),
        { platform: 'ios' }
      )
      expect(await music.access()).equals(expected)
    }
    const broken = makeWalkUpMusic(
      fakeModule({
        access: async () => {
          throw new Error('no MusicKit')
        }
      }),
      { platform: 'ios' }
    )
    expect(await broken.access()).equals('unavailable')
  })

  it('cleans candidates, and drops ones it cannot use', async function () {
    const module = fakeModule({
      search: async () => [
        raw,
        { ...raw, provider: 'spotify' },
        { ...raw, durationMs: 0 },
        { ...raw, handle: '' }
      ],
      pickFile: async () => ({ ...raw, artist: ' ', source: 'library' })
    })
    const music = makeWalkUpMusic(module, { platform: 'android' })
    expect(await music.search('fixture')).deep.equals([
      {
        provider: 'localFile',
        providerId: 'lf:110f83a3e9419109',
        isrc: null,
        title: 'TS Walkup Fixture',
        artist: 'TeamStation Test',
        album: null,
        artworkUrl: null,
        durationMs: 90000,
        source: 'device',
        handle: 'content://media/external/audio/media/31'
      }
    ])
    expect((await music.pickFile())?.artist).equals('—')
    expect(asCandidate({ ...raw, source: 'cloud' })).equals(null)
    expect(asCandidate({ ...raw, title: '  ' })).equals(null)
    expect(asCandidate({ ...raw, providerId: '' })).equals(null)
    const none = makeWalkUpMusic(fakeModule(), { platform: 'android' })
    expect(await none.pickFile()).equals(null)
  })

  it('forwards the clip and its fades as numbers', async function () {
    const module = fakeModule()
    const music = makeWalkUpMusic(module, { platform: 'android' })
    await music.play('content://1', 5000, 20000, { inMs: 500, outMs: 1500 })
    await music.play('catalog:1', 10000, 25000, { inMs: 0, outMs: 0 })
    await music.stop(1500)
    expect(module.calls).deep.equals([
      ['play', 'content://1', 5000, 20000, 500, 1500],
      ['play', 'catalog:1', 10000, 25000, 0, 0],
      ['stop', 1500]
    ])
  })

  it('passes the store’s own error on, as an Error', async function () {
    const music = makeWalkUpMusic(
      fakeModule({
        search: async () => {
          throw new Error('Failed to request developer token')
        },
        play: async () => {
          // A rejection that is not an Error still reaches the screen as one.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'Not subscribed'
        },
        pickFile: async () => {
          throw new Error('No picker')
        },
        stop: async () => {
          throw new Error('Stuck')
        }
      }),
      { platform: 'ios' }
    )
    const caught = async (call: () => Promise<unknown>): Promise<string> =>
      await call().then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'raw')
      )
    expect(await caught(async () => await music.search('x'))).equals(
      'Failed to request developer token'
    )
    expect(
      await caught(async () => {
        await music.play('h', 0, 1000, { inMs: 0, outMs: 0 })
      })
    ).equals('Not subscribed')
    expect(await caught(async () => await music.pickFile())).equals('No picker')
    expect(
      await caught(async () => {
        await music.stop(0)
      })
    ).equals('Stuck')
  })

  it('turns reports into states for every listener, and logs them all', function () {
    const module = fakeModule()
    const reports: NativeWalkUpMusicState[] = []
    const music = makeWalkUpMusic(module, {
      platform: 'ios',
      onReport: report => reports.push(report)
    })
    const seen: PlaybackState[] = []
    const unsubscribe = music.onState(state => seen.push(state))
    module.emit({ kind: 'playing', handle: 'h', positionMs: 5250, volume: 0.4 })
    module.emit({ kind: 'restored', restoredLevel: 0.5 })
    module.emit({ kind: 'idle', startLevel: 0.5, lowestLevel: 0 })
    unsubscribe()
    module.emit({ kind: 'error', message: 'Gone' })
    expect(seen).deep.equals([
      { kind: 'playing', handle: 'h', positionMs: 5250 },
      { kind: 'idle' }
    ])
    expect(reports.map(report => report.kind)).deep.equals([
      'playing',
      'restored',
      'idle',
      'error'
    ])
  })

  it('fills a sparse report', function () {
    expect(asPlaybackState({ kind: 'playing' })).deep.equals({
      kind: 'playing',
      handle: '',
      positionMs: 0
    })
    expect(asPlaybackState({ kind: 'error' })).deep.equals({
      kind: 'error',
      message: 'Playback failed'
    })
    expect(asPlaybackState({ kind: 'volume' })).equals(null)
  })
})

describe('musicLog', function () {
  it('gathers playing reports, and sends at idle to /logs', async function () {
    const posts: Array<{ url: string; body: unknown }> = []
    const log = musicLog(
      'http://192.168.7.40:9120/api/v1',
      'android',
      async (url, body) => {
        posts.push({ url, body: JSON.parse(body) })
      }
    )
    const quiet = console.log
    console.log = () => undefined
    try {
      log({ kind: 'playing', positionMs: 5000, volume: 0 })
      log({ kind: 'playing', positionMs: 5250, volume: 0.5 })
      expect(posts).deep.equals([])
      log({ kind: 'idle', lowestLevel: 0 })
    } finally {
      console.log = quiet
    }
    expect(posts).length(1)
    expect(posts[0].url).equals('http://192.168.7.40:9120/api/v1/logs')
    const body = posts[0].body as {
      source: string
      run: string
      lines: Array<{
        level: string
        text: string
        data: NativeWalkUpMusicState
      }>
    }
    expect(body.source).equals('walkUpMusic-android')
    expect(body.run).a('string')
    expect(body.lines.map(line => line.text)).deep.equals([
      'WalkUpMusicState playing',
      'WalkUpMusicState playing',
      'WalkUpMusicState idle'
    ])
    expect(body.lines[1].data.volume).equals(0.5)
  })

  it('sends playing reports after a second on their own, and drops a failed post', async function () {
    let sent = 0
    const log = musicLog('http://x/api/v1', 'ios', async () => {
      sent++
      throw new Error('offline')
    })
    const quiet = console.log
    console.log = () => undefined
    try {
      log({ kind: 'playing', positionMs: 1 })
      await new Promise(resolve => setTimeout(resolve, 1100))
      expect(sent).equals(1)
      for (let i = 0; i < 50; i++) log({ kind: 'playing', positionMs: i })
      expect(sent).equals(2)
    } finally {
      console.log = quiet
    }
  })

  it('posts JSON with fetch by default', async function () {
    const saved = globalThis.fetch
    const asked: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init })
      return new Response('{}')
    }) as typeof fetch
    const quiet = console.log
    console.log = () => undefined
    try {
      musicLog('http://x/api/v1', 'ios')({ kind: 'idle' })
    } finally {
      console.log = quiet
      globalThis.fetch = saved
    }
    expect(asked).length(1)
    expect(asked[0].init?.method).equals('POST')
  })
})
