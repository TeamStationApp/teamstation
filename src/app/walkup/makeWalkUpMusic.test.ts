import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asCandidate,
  asOfflineReport,
  asPlaybackState,
  makeWalkUpMusic,
  type WalkUpClip,
  type WalkUpMusicModule
} from './makeWalkUpMusic'
import { musicLog } from './musicLog'
import type {
  NativeSongCandidate,
  NativeWalkUpMusicState
} from './NativeWalkUpMusic'
import { NO_WALK_UP_MUSIC } from './useWalkUpNote'
import webMusic from './walkUpMusic'
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
    prepareOffline: async providerIds => {
      calls.push(['prepareOffline', providerIds])
      return {
        authorized: true,
        subscribed: true,
        syncLibrary: true,
        songs: []
      }
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

  it('offers DJ Game on an iPhone only', function () {
    expect(
      makeWalkUpMusic(fakeModule(), { platform: 'ios' }).djSupported
    ).equals(true)
    expect(
      makeWalkUpMusic(fakeModule(), { platform: 'android' }).djSupported
    ).equals(false)
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

  it('forwards the clip and its fades as numbers, and reports each start', async function () {
    const module = fakeModule()
    const started: WalkUpClip[] = []
    const music = makeWalkUpMusic(module, {
      platform: 'android',
      onPlay: clip => started.push(clip)
    })
    await music.play('content://1', 5000, 20000, { inMs: 500, outMs: 1500 })
    await music.play('catalog:1', 10000, 25000, { inMs: 0, outMs: 0 })
    await music.stop(1500)
    expect(module.calls).deep.equals([
      ['play', 'content://1', 5000, 20000, 500, 1500],
      ['play', 'catalog:1', 10000, 25000, 0, 0],
      ['stop', 1500]
    ])
    expect(started).deep.equals([
      {
        handle: 'content://1',
        startMs: 5000,
        endMs: 20000,
        fadeInMs: 500,
        fadeOutMs: 1500
      },
      {
        handle: 'catalog:1',
        startMs: 10000,
        endMs: 25000,
        fadeInMs: 0,
        fadeOutMs: 0
      }
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

  it('gets a game’s songs ready on an iPhone, reading each state', async function () {
    const module = fakeModule({
      prepareOffline: async providerIds => {
        module.calls.push(['prepareOffline', providerIds])
        return {
          authorized: true,
          subscribed: true,
          syncLibrary: true,
          songs: [
            { providerId: '1', state: 'downloaded' },
            { providerId: '2', state: 'pending' },
            { providerId: '3', state: 'added' },
            { providerId: '4', state: 'unavailable' },
            { providerId: '5', state: 'sideways' }
          ]
        }
      }
    })
    const music = makeWalkUpMusic(module, { platform: 'ios' })
    expect(await music.prepareOffline(['1', '2', '3', '4', '5'])).deep.equals({
      authorized: true,
      subscribed: true,
      syncLibrary: true,
      songs: [
        { providerId: '1', state: 'downloaded' },
        { providerId: '2', state: 'pending' },
        { providerId: '3', state: 'added' },
        { providerId: '4', state: 'unavailable' },
        { providerId: '5', state: 'unavailable' }
      ]
    })
    expect(module.calls).deep.equals([
      ['prepareOffline', ['1', '2', '3', '4', '5']]
    ])
  })

  it('has nothing to get ready on Android, with no songs, or when it fails', async function () {
    const android = fakeModule()
    expect(
      await makeWalkUpMusic(android, { platform: 'android' }).prepareOffline([
        '1'
      ])
    ).equals(null)
    expect(android.calls).deep.equals([])
    const ios = fakeModule()
    expect(
      await makeWalkUpMusic(ios, { platform: 'ios' }).prepareOffline([])
    ).equals(null)
    expect(ios.calls).deep.equals([])
    const broken = makeWalkUpMusic(
      fakeModule({
        prepareOffline: async () => {
          throw new Error('MusicKit went away')
        }
      }),
      { platform: 'ios' }
    )
    const quiet = console.log
    console.log = () => undefined
    try {
      expect(await broken.prepareOffline(['1'])).equals(null)
    } finally {
      console.log = quiet
    }
  })

  it('reads a report with no access as nothing granted', function () {
    expect(
      asOfflineReport({
        authorized: false,
        subscribed: false,
        syncLibrary: false,
        songs: []
      })
    ).deep.equals({
      authorized: false,
      subscribed: false,
      syncLibrary: false,
      songs: []
    })
  })

  it('treats the offline reports as no playback state', function () {
    expect(
      asPlaybackState({ kind: 'offline', count: 2, added: 1, pending: 1 })
    ).equals(null)
    expect(
      asPlaybackState({ kind: 'offlineSong', providerId: '1', state: 'added' })
    ).equals(null)
  })

  it('offers neither DJ Game nor offline songs on the web or with no music', async function () {
    for (const music of [webMusic, NO_WALK_UP_MUSIC]) {
      expect(music.djSupported).equals(false)
      expect(await music.prepareOffline(['1'])).equals(null)
    }
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
  function harness(): {
    log: ReturnType<typeof musicLog>
    crumbs: Array<{ level?: string; message?: string; data?: unknown }>
  } {
    const crumbs: Array<{ level?: string; message?: string; data?: unknown }> =
      []
    const log = musicLog({
      addBreadcrumb: crumb => {
        expect(crumb.category).equals('walkUpMusic')
        crumbs.push({
          level: crumb.level,
          message: crumb.message,
          data: crumb.data
        })
      }
    })
    return { log, crumbs }
  }

  function quietly(run: () => void): void {
    const quiet = console.log
    console.log = () => undefined
    try {
      run()
    } finally {
      console.log = quiet
    }
  }

  const clip = (handle: string, startMs: number): WalkUpClip => ({
    handle,
    startMs,
    endMs: startMs + 15000,
    fadeInMs: 0,
    fadeOutMs: 1500
  })

  it('keeps each start, its first playing report, and every other report', function () {
    const { log, crumbs } = harness()
    quietly(() => {
      log.onPlay(clip('a', 5000))
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 5000 })
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 5250 })
      log.onReport({ kind: 'volume', fade: 'released', volume: 0.5 })
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 5500 })
      log.onReport({ kind: 'idle', handle: 'a', lowestLevel: 0 })
      log.onPlay(clip('b', 0))
      log.onReport({ kind: 'playing', handle: 'b', positionMs: 0 })
      log.onReport({ kind: 'playing', handle: 'b', positionMs: 250 })
    })
    expect(crumbs.map(crumb => crumb.message)).deep.equals([
      'WalkUpMusic play',
      'WalkUpMusicState playing',
      'WalkUpMusicState volume',
      'WalkUpMusicState idle',
      'WalkUpMusic play',
      'WalkUpMusicState playing'
    ])
    expect(crumbs[0].data).deep.equals(clip('a', 5000))
    expect(crumbs[1].data).deep.equals({
      kind: 'playing',
      handle: 'a',
      positionMs: 5000
    })
    expect(crumbs.every(crumb => crumb.level === 'info')).equals(true)
  })

  it('keeps a replay of the same song, from a later start, with no idle between', function () {
    const { log, crumbs } = harness()
    quietly(() => {
      log.onPlay(clip('a', 30000))
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 30000 })
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 30250 })
      log.onPlay(clip('a', 45000))
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 45000 })
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 44990 })
    })
    expect(crumbs.map(crumb => crumb.data)).deep.equals([
      clip('a', 30000),
      { kind: 'playing', handle: 'a', positionMs: 30000 },
      clip('a', 45000),
      { kind: 'playing', handle: 'a', positionMs: 45000 }
    ])
  })

  it('waits for the new clip’s own tick when the old clip’s arrive late', function () {
    const { log, crumbs } = harness()
    quietly(() => {
      log.onPlay(clip('a', 0))
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 0 })
      log.onPlay(clip('b', 10000))
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 250 })
      log.onReport({ kind: 'playing', handle: 'b', positionMs: 10000 })
      log.onPlay(clip('b', 40000))
      log.onReport({ kind: 'playing', handle: 'b', positionMs: 10250 })
      log.onReport({ kind: 'playing', handle: 'b', positionMs: 39800 })
      log.onReport({ kind: 'playing', handle: 'b', positionMs: 40050 })
    })
    expect(crumbs.map(crumb => crumb.data)).deep.equals([
      clip('a', 0),
      { kind: 'playing', handle: 'a', positionMs: 0 },
      clip('b', 10000),
      { kind: 'playing', handle: 'b', positionMs: 10000 },
      clip('b', 40000),
      { kind: 'playing', handle: 'b', positionMs: 39800 }
    ])
  })

  it('keeps an error at the error level, and sends no event the screen explains', function () {
    const { log, crumbs } = harness()
    quietly(() => {
      log.onPlay(clip('a', 0))
      log.onReport({ kind: 'error', handle: 'a', message: 'Media unavailable' })
      log.onReport({ kind: 'error' })
    })
    expect(crumbs.map(crumb => crumb.level)).deep.equals([
      'info',
      'error',
      'error'
    ])
    expect(crumbs[1].data).deep.equals({
      kind: 'error',
      handle: 'a',
      message: 'Media unavailable'
    })
  })

  it('keeps a visit’s offline summary and each song not yet on the phone', function () {
    const { log, crumbs } = harness()
    quietly(() => {
      log.onReport({ kind: 'offline', count: 3, downloaded: 2, pending: 1 })
      log.onReport({
        kind: 'offlineSong',
        providerId: '1',
        state: 'downloaded'
      })
      log.onReport({ kind: 'offlineSong', providerId: '2', state: 'pending' })
      log.onReport({
        kind: 'offlineSong',
        providerId: '3',
        state: 'downloaded'
      })
    })
    expect(crumbs.map(crumb => crumb.data)).deep.equals([
      { kind: 'offline', count: 3, downloaded: 2, pending: 1 },
      { kind: 'offlineSong', providerId: '2', state: 'pending' }
    ])
  })

  it('writes every report to the device log', function () {
    const { log } = harness()
    const lines: string[] = []
    const saved = console.log
    console.log = (line: string) => lines.push(line)
    try {
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 0 })
      log.onReport({ kind: 'playing', handle: 'a', positionMs: 250 })
    } finally {
      console.log = saved
    }
    expect(lines).deep.equals([
      'WalkUpMusicState {"kind":"playing","handle":"a","positionMs":0}',
      'WalkUpMusicState {"kind":"playing","handle":"a","positionMs":250}'
    ])
  })
})
