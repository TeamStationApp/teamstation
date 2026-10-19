import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  type RosterEntry,
  type TeamStationClient
} from '../../common/api'
import type { WalkUpSong } from '../../common/walkUpSong'
import { ThemeProvider } from '../theme/ThemeContext'
import webMusic, {
  type PlaybackState,
  WALK_UP_FADE,
  type WalkUpMusic
} from './walkUpMusic'
import { WalkUpTab, type WalkUpTabProps } from './WalkUpTab'

/**
 * A player's Walk-up tab: the song as the roster has it, and on a phone the
 * buttons that change and play it. The web draws the same song and says
 * where to change it, with no button that would fail.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(props: Partial<WalkUpTabProps> = {}): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <WalkUpTab
          client={songClient()}
          teamId="t1"
          userId="7"
          music={webMusic}
          {...props}
        />
      </ThemeProvider>
    )
    await delay(20)
  })
}

const buttons = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="button"]')
]
const labels = (): string[] => buttons().map(node => node.textContent ?? '')
function button(label: string): HTMLElement {
  const found = buttons().find(node =>
    (node.textContent ?? '').startsWith(label)
  )
  expect(found, label).not.equals(undefined)
  return found!
}
const disabled = (label: string): boolean =>
  button(label).getAttribute('aria-disabled') === 'true'
async function press(label: string): Promise<void> {
  const found = button(label)
  await act(async () => {
    found.click()
    await delay(20)
  })
}
const text = (): string => document.body.textContent ?? ''
const never = new Promise<RosterEntry[]>(() => undefined)

const centerfield: WalkUpSong = {
  provider: 'appleMusic',
  providerId: '1440833098',
  isrc: 'USFI88500001',
  title: 'Centerfield',
  artist: 'John Fogerty',
  album: 'Centerfield',
  artworkUrl: 'https://example.com/centerfield.jpg',
  durationMs: 233000,
  startMs: 10000,
  endMs: 25000
}
const fixture: WalkUpSong = {
  provider: 'localFile',
  providerId: 'lf:0123456789abcdef',
  isrc: null,
  title: 'Walkup Fixture',
  artist: 'TeamStation',
  album: null,
  artworkUrl: null,
  durationMs: 90000,
  startMs: 5000,
  endMs: 20000
}

function entry(song: WalkUpSong | null, userId = 7): RosterEntry {
  return asRosterEntry({
    userId,
    gumboId: userId,
    shortName: 'Jordan P',
    jersey: '4',
    positions: ['CF'],
    bats: 'right',
    throws: 'right',
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    walkUpSong: song
  })
}

function songClient(
  options: {
    song?: WalkUpSong | null
    roster?: () => Promise<RosterEntry[]>
    clear?: () => Promise<void>
    cleared?: string[]
  } = {}
): TeamStationClient {
  const { song = centerfield, cleared = [] } = options
  return {
    roster: options.roster ?? (async () => [entry(song)]),
    clearWalkUpSong: async (teamId: string, userId: string) => {
      cleared.push(`${teamId}/${userId}`)
      if (options.clear != null) await options.clear()
    }
  } as unknown as TeamStationClient
}

interface Played {
  handle: string
  startMs: number
  endMs: number
  fade: { inMs: number; outMs: number }
}

/** A phone's music, as a test drives it. */
function fakeMusic(
  options: { play?: () => Promise<void> } = {}
): WalkUpMusic & {
  played: Played[]
  stops: number[]
  emit: (state: PlaybackState) => void
  listeners: Set<(state: PlaybackState) => void>
} {
  const listeners = new Set<(state: PlaybackState) => void>()
  const played: Played[] = []
  const stops: number[] = []
  return {
    available: true,
    djSupported: false,
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
    prepareOffline: async () => null,
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

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

describe('the Walk-up tab’s song', function () {
  it('shows an Apple Music song with its artwork, clip and provider', async function () {
    await render()
    expect(text()).includes('Centerfield')
    expect(text()).includes('John Fogerty')
    expect(text()).includes('Plays 0:10–0:25')
    expect(text()).includes('Apple Music')
    const picture = document.querySelector('img')
    expect(picture?.getAttribute('src')).equals(
      'https://example.com/centerfield.jpg'
    )
  })

  it('shows a file on the phone as a music-note tile', async function () {
    await render({ client: songClient({ song: fixture }) })
    expect(text()).includes('Walkup Fixture')
    expect(text()).includes('A file on the phone')
    expect(text()).includes('music_note')
    expect(document.querySelector('img')).equals(null)
  })

  it('says when there is no song', async function () {
    await render({ client: songClient({ song: null }) })
    expect(text()).includes('No walk-up song yet')
  })

  it('says so when the player is not on the team, or the roster fails', async function () {
    await render({
      client: songClient({ roster: async () => [entry(null, 8)] })
    })
    expect(text()).includes('not on this team')
    await act(async () => {
      root?.unmount()
    })
    await render({
      client: songClient({
        roster: async () => {
          throw new Error('offline')
        }
      })
    })
    expect(text()).includes('Cannot load this player’s walk-up song.')
  })

  it('reads Loading while the roster is on its way', async function () {
    await render({ client: songClient({ roster: async () => await never }) })
    expect(text()).includes('Loading')
  })
})

describe('the Walk-up tab on the web', function () {
  it('says where to set songs, and offers no button', async function () {
    await render({ onPick: () => undefined })
    expect(text()).includes(
      'Set walk-up songs in the TeamStation app on iPhone or Android.'
    )
    expect(labels()).deep.equals([])
  })

  it('has an adapter that plays nothing', async function () {
    expect(webMusic.available).equals(false)
    for (const call of [
      async () => await webMusic.access(),
      async () => await webMusic.search('centerfield'),
      async () => await webMusic.pickFile(),
      async () => {
        await webMusic.play('h', 0, 1000, WALK_UP_FADE)
      },
      async () => {
        await webMusic.stop(0)
      }
    ]) {
      const caught = await call().then(
        () => undefined,
        (error: unknown) => error
      )
      expect(caught).instanceOf(Error)
    }
    const unsubscribe = webMusic.onState(() => undefined)
    expect(unsubscribe).a('function')
    unsubscribe()
  })
})

describe('the Walk-up tab on a phone', function () {
  it('offers Set with no song, and Change with one', async function () {
    const picked: Array<WalkUpSong | null> = []
    const onPick = (song: WalkUpSong | null): void => {
      picked.push(song)
    }
    await render({
      client: songClient({ song: null }),
      music: fakeMusic(),
      onPick
    })
    expect(labels()).deep.equals(['Set'])
    expect(text()).not.includes('Set walk-up songs in the TeamStation app')
    await press('Set')
    await act(async () => {
      root?.unmount()
    })
    await render({ music: fakeMusic(), onPick })
    expect(labels()).deep.equals(['Change', 'Not on this phone', 'Remove'])
    await press('Change')
    expect(picked).deep.equals([null, centerfield])
  })

  it('leaves Set and Change out with nowhere to pick a song', async function () {
    await render({ music: fakeMusic() })
    expect(labels()).deep.equals(['Not on this phone', 'Remove'])
  })

  it('disables Preview when the song is not on this phone', async function () {
    for (const resolve of [
      undefined,
      async () => null,
      async () => {
        throw new Error('search failed')
      }
    ]) {
      const music = fakeMusic()
      await render({ music, resolve })
      expect(disabled('Not on this phone')).equals(true)
      await press('Not on this phone')
      expect(music.played).deep.equals([])
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('previews the clip with its fades, and stops it again', async function () {
    const music = fakeMusic()
    const asked: WalkUpSong[] = []
    await render({
      music,
      resolve: async song => {
        asked.push(song)
        return 'catalog:1440833098'
      }
    })
    expect(asked).deep.equals([centerfield])
    expect(disabled('Preview')).equals(false)
    await press('Preview')
    expect(music.played).deep.equals([
      {
        handle: 'catalog:1440833098',
        startMs: 10000,
        endMs: 25000,
        fade: { inMs: 1500, outMs: 1500 }
      }
    ])
    await press('Stop')
    expect(music.stops).deep.equals([0])
    expect(labels()).includes('Preview')

    // The clip ends on its own.
    await press('Preview')
    await act(async () => {
      music.emit({
        kind: 'playing',
        handle: 'catalog:1440833098',
        positionMs: 1
      })
      await delay(5)
    })
    expect(labels()).includes('Stop')
    await act(async () => {
      music.emit({ kind: 'idle' })
      await delay(5)
    })
    expect(labels()).includes('Preview')

    // And a failure says why.
    await press('Preview')
    await act(async () => {
      music.emit({ kind: 'error', message: 'Playback failed' })
      await delay(5)
    })
    expect(text()).includes('Playback failed')
    expect(labels()).includes('Preview')
  })

  it('shows a refusal to play', async function () {
    const music = fakeMusic({
      play: async () => {
        throw new Error('Not authorised')
      }
    })
    await render({ music, resolve: async () => 'h' })
    await press('Preview')
    expect(text()).includes('Not authorised')
    expect(labels()).includes('Preview')
  })

  it('stops a clip still playing when the page goes', async function () {
    const music = fakeMusic()
    await render({ music, resolve: async () => 'h' })
    await press('Preview')
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(music.stops).deep.equals([0])
    expect(music.listeners.size).equals(0)
  })

  it('removes the song only when asked twice', async function () {
    const cleared: string[] = []
    await render({ client: songClient({ cleared }), music: fakeMusic() })
    await press('Remove')
    expect(cleared).deep.equals([])
    expect(labels()).includes('Tap again to remove')
    await press('Tap again to remove')
    expect(cleared).deep.equals(['t1/7'])
    expect(text()).includes('No walk-up song yet')
    expect(labels()).deep.equals([])
  })

  it('keeps the song and shows why when Remove fails', async function () {
    for (const [thrown, shown] of [
      [new Error('Not found'), 'Not found'],
      [new Error(''), 'Cannot remove this walk-up song.']
    ] as const) {
      await render({
        client: songClient({
          clear: async () => {
            throw thrown
          }
        }),
        music: fakeMusic()
      })
      await press('Remove')
      await press('Tap again to remove')
      expect(text()).includes(shown)
      expect(text()).includes('Centerfield')
      await act(async () => {
        root?.unmount()
      })
    }
  })
})
