import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type { Session } from '../../common/api'
import { AccountScreen } from '../screens/AccountScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  clipFade,
  type ClipRequest,
  type SongPlayer,
  useSongPlayer
} from './useSongPlayer'
import type { PlaybackState, WalkUpMusic } from './walkUpMusicTypes'
import {
  DEFAULT_WALK_UP_PREFERENCES,
  useWalkUpPreferences,
  walkUpPreferences,
  walkUpPreferenceStore
} from './walkUpPreferences'

let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Played {
  handle: string
  startMs: number
  endMs: number
  fade: { inMs: number; outMs: number }
}

function fakeMusic(
  options: { play?: () => Promise<void> } = {}
): WalkUpMusic & {
  played: Played[]
  stops: number[]
  listeners: Set<(state: PlaybackState) => void>
  emit: (state: PlaybackState) => void
} {
  const listeners = new Set<(state: PlaybackState) => void>()
  const played: Played[] = []
  const stops: number[] = []
  return {
    available: true,
    providerName: 'Apple Music',
    access: async () => 'authorized',
    search: async () => [],
    pickFile: async () => null,
    play: async (handle, startMs, endMs, fade) => {
      played.push({ handle, startMs, endMs, fade })
      if (options.play != null) await options.play()
    },
    stop: async fadeMs => {
      stops.push(fadeMs)
    },
    onState: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    played,
    stops,
    listeners,
    emit: state => {
      for (const listener of listeners) listener(state)
    }
  }
}

let player: SongPlayer | undefined
function Harness(props: {
  music: WalkUpMusic
  fadeAppleMusic?: boolean
}): React.ReactElement {
  player = useSongPlayer(props.music, props.fadeAppleMusic)
  return (
    <div>
      {player.playing ?? 'none'}|{player.error ?? ''}
    </div>
  )
}

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(10)
  })
}

async function run(step: () => void): Promise<void> {
  await act(async () => {
    step()
    await delay(10)
  })
}

const text = (): string => document.body.textContent ?? ''
const fileB: ClipRequest = {
  key: 'b',
  handle: 'content://b',
  provider: 'localFile',
  startMs: 5000,
  endMs: 20000
}
const appleC: ClipRequest = {
  key: 'c',
  handle: 'catalog:1',
  provider: 'appleMusic',
  startMs: 10000,
  endMs: 25000
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  player = undefined
})

describe('useSongPlayer', function () {
  it('plays one clip at a time, and stops on a second tap', async function () {
    const music = fakeMusic()
    await mount(<Harness music={music} />)
    await run(() => {
      player!.toggle(fileB)
    })
    expect(text()).includes('b|')
    await run(() => {
      player!.toggle(appleC)
    })
    expect(text()).includes('c|')
    expect(music.played.map(clip => clip.handle)).deep.equals([
      'content://b',
      'catalog:1'
    ])
    await run(() => {
      player!.toggle(appleC)
    })
    expect(text()).includes('none|')
    expect(music.stops).deep.equals([1500])
  })

  it('clears at the clip’s own end, and shows an error', async function () {
    const music = fakeMusic()
    await mount(<Harness music={music} />)
    await run(() => {
      player!.play(fileB)
    })
    await run(() => {
      music.emit({ kind: 'playing', handle: 'content://b', positionMs: 6000 })
    })
    expect(text()).includes('b|')
    await run(() => {
      music.emit({ kind: 'idle' })
    })
    expect(text()).includes('none|')
    await run(() => {
      player!.play(fileB)
    })
    await run(() => {
      music.emit({ kind: 'error', message: 'Decoder failed' })
    })
    expect(text()).includes('none|Decoder failed')
    await run(() => {
      player!.play(fileB)
    })
    expect(text()).includes('b|')
  })

  it('surfaces a refused play', async function () {
    const music = fakeMusic({
      play: async () => {
        throw new Error('Not subscribed to Apple Music')
      }
    })
    await mount(<Harness music={music} />)
    await run(() => {
      player!.play(appleC)
    })
    expect(text()).includes('none|Not subscribed to Apple Music')
    const raw = fakeMusic({
      play: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'raw'
      }
    })
    await act(async () => {
      root?.unmount()
    })
    await mount(<Harness music={raw} />)
    await run(() => {
      player!.play(appleC)
    })
    expect(text()).includes('none|raw')
  })

  it('stops on unmount, and only when something plays', async function () {
    const music = fakeMusic()
    await mount(<Harness music={music} />)
    await act(async () => {
      root?.unmount()
    })
    expect(music.stops).deep.equals([])
    await mount(<Harness music={music} />)
    await run(() => {
      player!.play(fileB)
    })
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(music.stops).deep.equals([0])
    expect(music.listeners.size).equals(0)
  })

  it('fades files always, and Apple Music only with the setting on', async function () {
    const music = fakeMusic()
    await mount(<Harness music={music} fadeAppleMusic={false} />)
    await run(() => {
      player!.play(fileB)
    })
    await run(() => {
      player!.play(appleC)
    })
    // Fade is off for Apple Music, so a second tap stops hard. An explicit
    // stop still asks for its 1.5 s: the phone decides that a clip that
    // started hard also stops hard.
    await run(() => {
      player!.toggle(appleC)
    })
    expect(music.stops).deep.equals([0])
    await run(() => {
      player!.stop(1500)
    })
    expect(music.played.map(clip => clip.fade)).deep.equals([
      { inMs: 1500, outMs: 1500 },
      { inMs: 0, outMs: 0 }
    ])
    expect(music.stops).deep.equals([0, 1500])
    expect(clipFade('appleMusic', true, 10000)).deep.equals({
      inMs: 1500,
      outMs: 1500
    })
    expect(clipFade('appleMusic', true, 0)).deep.equals({
      inMs: 0,
      outMs: 1500
    })
    expect(clipFade('localFile', false, 5000)).deep.equals({
      inMs: 1500,
      outMs: 1500
    })
  })

  it('does nothing with the web’s adapter', async function () {
    const music = { ...fakeMusic(), available: false }
    await mount(<Harness music={music} />)
    expect(music.listeners.size).equals(0)
  })
})

function memory(): {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  items: Map<string, string>
} {
  const items = new Map<string, string>()
  return {
    items,
    getItem: async key => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value)
    }
  }
}

describe('the walk-up fade setting', function () {
  beforeEach(function () {
    window.localStorage.clear()
  })

  it('is on by default, and persists per device', async function () {
    const storage = memory()
    const store = walkUpPreferenceStore(storage)
    expect(await store.read()).deep.equals({ fadeAppleMusic: true })
    await store.write({ fadeAppleMusic: false })
    expect(await store.read()).deep.equals({ fadeAppleMusic: false })
    expect([...storage.items.keys()]).deep.equals([
      'gamestation:walkUp:preferences'
    ])
    storage.items.set('gamestation:walkUp:preferences', '{broken')
    expect(await store.read()).equals(DEFAULT_WALK_UP_PREFERENCES)
    storage.items.set('gamestation:walkUp:preferences', '7')
    expect(await store.read()).equals(DEFAULT_WALK_UP_PREFERENCES)
    storage.items.set('gamestation:walkUp:preferences', '{}')
    expect(await store.read()).deep.equals({ fadeAppleMusic: true })
    const refusing = walkUpPreferenceStore({
      getItem: async () => null,
      setItem: async () => {
        throw new Error('full')
      }
    })
    await refusing.write({ fadeAppleMusic: false })
  })

  it('reaches every screen using it at once', async function () {
    let first: ReturnType<typeof useWalkUpPreferences> | undefined
    let second: ReturnType<typeof useWalkUpPreferences> | undefined
    function Two(): React.ReactElement {
      first = useWalkUpPreferences()
      second = useWalkUpPreferences()
      return <div>{String(second[0].fadeAppleMusic)}</div>
    }
    await mount(<Two />)
    expect(text()).equals('true')
    await run(() => {
      first![1]({ fadeAppleMusic: false })
    })
    expect(text()).equals('false')
    expect(await walkUpPreferences.read()).deep.equals({
      fadeAppleMusic: false
    })
  })

  describe('on the Account screen', function () {
    const web = Platform.OS
    afterEach(function () {
      Platform.OS = web
    })

    const session = {
      token: 't',
      user: {
        id: '1',
        displayName: 'Sam Songkeeper',
        email: 's@x',
        isAdmin: false
      }
    } as unknown as Session
    function account(): React.ReactElement {
      return <AccountScreen session={session} onSignOut={() => undefined} />
    }

    it('shows the switch on an iPhone only, and writes the setting', async function () {
      await mount(account())
      expect(text().toLowerCase()).not.includes('walk-up songs')
      await act(async () => {
        root?.unmount()
      })
      Platform.OS = 'android'
      await mount(account())
      expect(text().toLowerCase()).not.includes('walk-up songs')
      await act(async () => {
        root?.unmount()
      })
      Platform.OS = 'ios'
      await mount(account())
      expect(text().toLowerCase()).includes('walk-up songs')
      expect(text()).includes('Some Bluetooth speakers beep')
      const toggle = document.querySelector<HTMLInputElement>(
        'input[aria-label="Fade Apple Music using the phone’s volume"]'
      )
      expect(toggle?.checked).equals(true)
      await run(() => {
        toggle!.click()
      })
      expect(await walkUpPreferences.read()).deep.equals({
        fadeAppleMusic: false
      })
    })
  })
})
