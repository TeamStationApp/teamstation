import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { WalkUpSong } from '../../common/walkUpSong'
import { HeaderSlotProvider } from '../components/headerSlot'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { ThemeProvider } from '../theme/ThemeContext'
import { deviceLinkStore } from './resolveSong'
import type {
  MusicAccess,
  PlaybackState,
  SongCandidate,
  WalkUpMusic
} from './walkUpMusicTypes'
import {
  WalkUpSongScreen,
  type WalkUpSongScreenProps
} from './WalkUpSongScreen'

/**
 * The song picker: access, the search step, and the clip step with Save.
 */
let root: Root | undefined
let backHandler: (() => void) | null = null
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const web = Platform.OS

const fixture: SongCandidate = {
  provider: 'localFile',
  providerId: 'lf:110f83a3e9419109',
  isrc: null,
  title: 'TS Walkup Fixture',
  artist: 'TeamStation Test',
  album: 'Fixtures',
  artworkUrl: null,
  durationMs: 90000,
  source: 'device',
  handle: 'content://media/external/audio/media/31'
}
const centerfield: SongCandidate = {
  provider: 'appleMusic',
  providerId: '1440833098',
  isrc: 'USFI88500001',
  title: 'Centerfield',
  artist: 'John Fogerty',
  album: null,
  artworkUrl: 'https://example.com/c.jpg',
  durationMs: 233000,
  source: 'catalog',
  handle: 'catalog:1440833098'
}
const saved: WalkUpSong = {
  provider: 'appleMusic',
  providerId: '1440833098',
  isrc: 'USFI88500001',
  title: 'Centerfield',
  artist: 'John Fogerty',
  album: 'Centerfield',
  artworkUrl: 'https://example.com/c.jpg',
  durationMs: 233000,
  startMs: 10000,
  endMs: 25000
}

interface Played {
  handle: string
  startMs: number
  endMs: number
  fade: { inMs: number; outMs: number }
}

function fakeMusic(
  options: {
    access?: () => Promise<MusicAccess>
    results?: SongCandidate[]
    pickFile?: () => Promise<SongCandidate | null>
  } = {}
): WalkUpMusic & { played: Played[]; stops: number[]; asked: number } {
  const played: Played[] = []
  const stops: number[] = []
  const music = {
    available: true,
    providerName: 'This phone',
    asked: 0,
    access: async () => {
      music.asked++
      return await (options.access?.() ??
        Promise.resolve('authorized' as const))
    },
    search: async () => options.results ?? [fixture, centerfield],
    pickFile: options.pickFile ?? (async () => null),
    play: async (
      handle: string,
      startMs: number,
      endMs: number,
      fade: { inMs: number; outMs: number }
    ) => {
      played.push({ handle, startMs, endMs, fade })
    },
    stop: async (fadeMs: number) => {
      stops.push(fadeMs)
    },
    onState: (_listener: (state: PlaybackState) => void) => () => undefined,
    played,
    stops
  }
  return music
}

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

function songClient(
  sent: Array<{ teamId: string; userId: string; song: WalkUpSong }>,
  fail?: Error
): TeamStationClient {
  return {
    setWalkUpSong: async (teamId: string, userId: string, song: WalkUpSong) => {
      sent.push({ teamId, userId, song })
      if (fail != null) throw fail
      return song
    }
  } as unknown as TeamStationClient
}

async function render(
  props: Partial<WalkUpSongScreenProps> = {}
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    backHandler = null
    root!.render(
      <ThemeProvider>
        <HeaderSlotProvider
          headerHeight={48}
          onHandoff={() => undefined}
          onBackOverride={handler => {
            backHandler = handler
          }}
        >
          <WalkUpSongScreen
            client={songClient([])}
            music={fakeMusic()}
            teamId="t1"
            userId="7"
            song={null}
            resolve={async () => null}
            onSaved={() => undefined}
            {...props}
          />
        </HeaderSlotProvider>
      </ThemeProvider>
    )
    await delay(20)
  })
}

const text = (): string => document.body.textContent ?? ''
const buttons = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="button"]')
]
function button(label: string): HTMLElement {
  const found = buttons().find(
    node =>
      (node.textContent ?? '').startsWith(label) ||
      (node.getAttribute('aria-label') ?? '').startsWith(label)
  )
  expect(found, label).not.equals(undefined)
  return found!
}
async function press(label: string, wait = 20): Promise<void> {
  const found = button(label)
  await act(async () => {
    found.click()
    await delay(wait)
  })
}
const disabled = (label: string): boolean =>
  button(label).getAttribute('aria-disabled') === 'true'
const labelled = (label: string): boolean =>
  document.querySelector(`[aria-label="${label}"]`) != null

async function search(term: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search"]'
  )!
  await act(async () => {
    // React listens for the native value setter, not the property itself.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!
    setter.call(input, term)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    await delay(400)
  })
}
const readout = (id: string): string =>
  document.querySelector(`[data-testid="walkup-${id}"]`)?.textContent ?? ''

afterEach(async function () {
  Platform.OS = web
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

describe('the song picker’s access', function () {
  it('explains a refusal, offers Settings, and asks again on return', async function () {
    let answer: MusicAccess = 'denied'
    const music = fakeMusic({ access: async () => answer })
    let opened = 0
    Platform.OS = 'android'
    await render({
      music,
      openSettings: () => {
        opened++
      }
    })
    expect(text()).includes('TeamStation can’t see your music')
    expect(text()).includes('read the music on this phone')
    await press('Open Settings')
    expect(opened).equals(1)
    answer = 'authorized'
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
      await delay(20)
    })
    expect(music.asked).equals(2)
    expect(text()).includes('Choose a file…')
  })

  it('says Apple Music on an iPhone, and names restricted and unavailable', async function () {
    Platform.OS = 'ios'
    await render({ music: fakeMusic({ access: async () => 'denied' }) })
    expect(text()).includes('use Apple Music')
    await act(async () => {
      root?.unmount()
    })
    await render({ music: fakeMusic({ access: async () => 'restricted' }) })
    expect(text()).includes('Music is restricted on this phone.')
    expect(buttons().map(node => node.textContent)).includes('Open Settings')
    await act(async () => {
      root?.unmount()
    })
    await render({
      music: fakeMusic({
        access: async () => {
          throw new Error('no module')
        }
      })
    })
    expect(text()).includes('Music isn’t available on this phone.')
    expect(buttons().map(node => node.textContent)).not.includes(
      'Open Settings'
    )
  })

  it('reads Checking while access is asked', async function () {
    await render({
      music: fakeMusic({
        access: async () => await new Promise(() => undefined)
      })
    })
    expect(text()).includes('Checking music access…')
  })
})

describe('the song picker’s search', function () {
  it('lists a source mark, the licence line, and Choose a file only on Android', async function () {
    Platform.OS = 'ios'
    await render()
    expect(text()).includes(
      'Playing music at a field may need the league’s performance licence.'
    )
    expect(text()).not.includes('Choose a file…')
    await search('centerfield')
    expect(text()).includes('TS Walkup Fixture')
    expect(text()).includes('TeamStation Test · Fixtures')
    expect(text()).not.includes('3:53')
    expect(labelled('On this phone')).equals(true)
    expect(labelled('Apple Music')).equals(true)
    await act(async () => {
      root?.unmount()
    })
    Platform.OS = 'android'
    await render({
      music: fakeMusic({
        results: [{ ...fixture, source: 'library', handle: 'library:1' }]
      })
    })
    expect(text()).includes('Choose a file…')
    await search('fixture')
    expect(labelled('Library')).equals(true)
  })

  it('says No songs match, and offers Retry after an error', async function () {
    await render({ music: fakeMusic({ results: [] }) })
    await search('zzzzqqq')
    expect(text()).includes('No songs match')
    await act(async () => {
      root?.unmount()
    })
    let fail = true
    const music = fakeMusic()
    music.search = async () => {
      if (fail) throw new Error('Failed to request developer token')
      return [centerfield]
    }
    await render({ music })
    await search('centerfield')
    expect(text()).includes('Failed to request developer token')
    fail = false
    await press('Retry')
    expect(text()).includes('Centerfield')
  })
})

describe('the song picker’s clip', function () {
  it('clips a found file, previews it with its fades, and saves it with a device link', async function () {
    Platform.OS = 'android'
    const sent: Array<{ teamId: string; userId: string; song: WalkUpSong }> = []
    const storage = memory()
    const music = fakeMusic()
    const done: WalkUpSong[] = []
    await render({
      client: songClient(sent),
      music,
      links: deviceLinkStore(storage),
      onSaved: song => done.push(song)
    })
    await search('walkup fixture')
    await press('TS Walkup Fixture')
    expect(readout('start')).equals('0:00.0')
    expect(readout('end')).equals('0:15.0')
    expect(text()).not.includes('15.0 s')
    expect(text()).not.includes('Preview')
    expect(text()).not.includes('Play from here')

    await press('Play')
    expect(labelled('Stop')).equals(true)
    expect(text()).not.includes('Stop')
    expect(music.played).deep.equals([
      {
        handle: fixture.handle,
        startMs: 0,
        endMs: 15000,
        fade: { inMs: 0, outMs: 1500 }
      }
    ])
    await press('Stop')
    expect(labelled('Play')).equals(true)
    expect(text()).not.includes('Play')
    expect(music.stops).deep.equals([0, 0])

    await press('Save')
    expect(sent).deep.equals([
      {
        teamId: 't1',
        userId: '7',
        song: {
          provider: 'localFile',
          providerId: fixture.providerId,
          isrc: null,
          title: 'TS Walkup Fixture',
          artist: 'TeamStation Test',
          album: 'Fixtures',
          artworkUrl: null,
          durationMs: 90000,
          startMs: 0,
          endMs: 15000
        }
      }
    ])
    expect(Object.fromEntries(storage.items)).deep.equals({
      'walkUp:t1:7:lf:110f83a3e9419109': fixture.handle
    })
    expect(done).length(1)
  })

  it('saves a picked file, and keeps the screen with the reason on failure', async function () {
    Platform.OS = 'android'
    const sent: Array<{ teamId: string; userId: string; song: WalkUpSong }> = []
    const storage = memory()
    const done: WalkUpSong[] = []
    await render({
      client: songClient(sent, new Error('Not found')),
      music: fakeMusic({
        pickFile: async () => ({ ...fixture, handle: 'content://picked/9' })
      }),
      links: deviceLinkStore(storage),
      onSaved: song => done.push(song)
    })
    await press('Choose a file…')
    await press('Save')
    expect(sent).length(1)
    expect(text()).includes('Not found')
    expect(done).deep.equals([])
    expect(storage.items.size).equals(0)
    expect(text()).includes('Pick another song')
  })

  it('says why a file could not be chosen, and stays on a cancelled pick', async function () {
    Platform.OS = 'android'
    await render({ music: fakeMusic({ pickFile: async () => null }) })
    await press('Choose a file…')
    expect(text()).includes('Choose a file…')
    await act(async () => {
      root?.unmount()
    })
    await render({
      music: fakeMusic({
        pickFile: async () => {
          throw new Error('')
        }
      })
    })
    await press('Choose a file…')
    expect(text()).includes('Music isn’t available on this phone.')
  })

  it('opens Change on the clip, with Pick another song, and saves Apple Music without a link', async function () {
    Platform.OS = 'ios'
    const sent: Array<{ teamId: string; userId: string; song: WalkUpSong }> = []
    const storage = memory()
    const music = fakeMusic()
    await render({
      client: songClient(sent),
      music,
      song: saved,
      resolve: async () => 'catalog:1440833098',
      links: deviceLinkStore(storage),
      fadeAppleMusic: false
    })
    expect(readout('start')).equals('0:10.0')
    expect(readout('end')).equals('0:25.0')
    expect(text()).includes('John Fogerty · Centerfield')
    await press('Play')
    expect(music.played[0].fade).deep.equals({ inMs: 0, outMs: 0 })
    await press('Save')
    expect(sent[0].song).deep.includes({ startMs: 10000, endMs: 25000 })
    expect(storage.items.size).equals(0)
  })

  it('offers no Play for a saved song not on this phone, and back returns from search', async function () {
    await render({ song: saved, resolve: async () => null })
    expect(disabled('Not on this phone')).equals(true)
    expect(text()).not.includes('Play from here')
    await press('Pick another song')
    expect(text()).includes('performance licence')
    expect(text()).not.includes('Pick another song')
    expect(backHandler).a('function')
    await act(async () => {
      backHandler?.()
      await delay(20)
    })
    expect(text()).includes('Centerfield')
    expect(text()).includes('Pick another song')
    expect(readout('start')).equals('0:10.0')
  })

  it('shows Start, End and Play above the timeline, and the jog wheel below it', async function () {
    await render({ song: saved, resolve: async () => 'catalog:1440833098' })
    const order = [
      '[data-testid="walkup-start"]',
      '[data-testid="walkup-end"]',
      '[aria-label="Play"]',
      '[data-testid="walkup-timeline"]',
      '[data-testid="walkup-jog"]'
    ].map(selector => document.querySelector(selector))
    order.forEach((node, i) => {
      expect(node, String(i)).not.equals(null)
    })
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) &
          window.Node.DOCUMENT_POSITION_FOLLOWING,
        String(i)
      ).not.equals(0)
    }
  })

  it('starts a playing clip again when the window is let go', async function () {
    const music = fakeMusic()
    await render({
      music,
      song: saved,
      resolve: async () => 'catalog:1440833098'
    })
    const timeline = document.querySelector<HTMLElement>(
      '[data-testid="walkup-timeline"]'
    )!
    const letGo = async (): Promise<void> => {
      await act(async () => {
        timeline.dispatchEvent(
          new window.MouseEvent('mousedown', {
            bubbles: true,
            clientX: 0,
            button: 0
          })
        )
        document.dispatchEvent(
          new window.MouseEvent('mouseup', { bubbles: true, clientX: 0 })
        )
        await delay(10)
      })
    }
    await letGo()
    expect(music.played).deep.equals([])
    await press('Play')
    await letGo()
    expect(music.played.map(play => play.startMs)).deep.equals([10000, 10000])
  })

  it('leaves the fifteen-second window in place when the touch does not move', async function () {
    await render({ song: saved, resolve: async () => null })
    const timeline = document.querySelector<HTMLElement>(
      '[data-testid="walkup-timeline"]'
    )!
    await act(async () => {
      timeline.dispatchEvent(
        new window.MouseEvent('mousedown', {
          bubbles: true,
          clientX: 0,
          button: 0
        })
      )
      document.dispatchEvent(
        new window.MouseEvent('mousemove', {
          bubbles: true,
          clientX: 0,
          buttons: 1
        })
      )
      document.dispatchEvent(
        new window.MouseEvent('mouseup', { bubbles: true, clientX: 0 })
      )
      await delay(10)
    })
    expect(readout('start')).equals('0:10.0')
    expect(readout('end')).equals('0:25.0')
  })
})
