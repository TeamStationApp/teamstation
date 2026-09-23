import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { RosterEntry } from '../../common/api'
import type { GameState } from '../../common/scoring/state'
import type { WalkUpSong } from '../../common/walkUpSong'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  NO_WALK_UP_MUSIC,
  useWalkUpNote,
  type WalkUpNote,
  type WalkUpNoteOptions,
  type WalkUpRosters
} from './useWalkUpNote'
import type {
  PlaybackState,
  SongCandidate,
  WalkUpMusic
} from './walkUpMusicTypes'

/**
 * U32: the scoring screen's music note — when it shows, what a tap does, and
 * when the song stops.
 */
let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

interface Played {
  handle: string
  startMs: number
  endMs: number
  fade: { inMs: number; outMs: number }
}
function fakeMusic(found: SongCandidate[] = []): WalkUpMusic & {
  played: Played[]
  stops: number[]
  searches: string[]
  emit: (state: PlaybackState) => void
} {
  const listeners = new Set<(state: PlaybackState) => void>()
  const played: Played[] = []
  const stops: number[] = []
  const searches: string[] = []
  return {
    available: true,
    providerName: 'Files',
    access: async () => 'authorized',
    search: async term => {
      searches.push(term)
      return found
    },
    pickFile: async () => null,
    play: async (handle, startMs, endMs, fade) => {
      played.push({ handle, startMs, endMs, fade })
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
    searches,
    emit: state => {
      for (const listener of listeners) listener(state)
    }
  }
}

const song = (title: string, providerId: string): WalkUpSong => ({
  provider: 'localFile',
  providerId,
  isrc: null,
  title,
  artist: 'Band',
  album: null,
  artworkUrl: null,
  durationMs: 90000,
  startMs: 10000,
  endMs: 25000
})
const tomSong = song('Walk This Way', 'lf:000000000000000b')
const phSong = song('Pinch Anthem', 'lf:000000000000000c')

const entry = (userId: number, walkUpSong: WalkUpSong | null): RosterEntry =>
  ({
    userId,
    shortName: `Player ${userId}`,
    walkUpSong
  }) as unknown as RosterEntry
const rosters: WalkUpRosters = {
  tem_t: [entry(101, null), entry(102, tomSong), entry(103, phSong)]
}

// Session ids 1-3 are T's players with user ids 101-103.
const players = {
  1: { id: 1, userId: 101, teamId: 'tem_t', fullName: 'Al A' },
  2: { id: 2, userId: 102, teamId: 'tem_t', fullName: 'Tom B' },
  3: { id: 3, userId: 103, teamId: 'tem_t', fullName: 'Pete C' },
  4: { id: 4, userId: null, teamId: 'tem_t', fullName: 'Guest' }
}
interface EventSketch {
  sub?: { player: number; replaced: number }
}
const pitch: EventSketch = {}
const pinchHit = (player: number, replaced: number): EventSketch => ({
  sub: { player, replaced }
})
function game(
  atBatIndex: number,
  batter: number,
  events: EventSketch[] = []
): GameState {
  return {
    gameData: { players },
    liveData: {
      plays: {
        allPlays: [],
        currentPlay: {
          about: { atBatIndex },
          matchup: { batter: { id: batter } },
          playEvents: events.map(event =>
            event.sub == null
              ? { details: { code: 'B' }, isPitch: true }
              : {
                  isSubstitution: true,
                  details: { code: 'offensive_substitution' },
                  position: 'PH',
                  player: { id: event.sub.player },
                  replacedPlayer: { id: event.sub.replaced }
                }
          )
        }
      }
    }
  } as unknown as GameState
}
const noPlay = {
  gameData: { players },
  liveData: { plays: {} }
} as unknown as GameState

let note: WalkUpNote | undefined
function Harness(props: {
  phase?: string
  session: GameState
  music: WalkUpMusic
  options?: WalkUpNoteOptions
}): React.ReactElement {
  note = useWalkUpNote(
    { phase: props.phase ?? 'ready', session: props.session },
    rosters,
    props.music,
    props.options
  )
  return <div />
}

async function show(props: Parameters<typeof Harness>[0]): Promise<void> {
  await act(async () => {
    if (root == null) {
      const node = document.createElement('div')
      document.body.appendChild(node)
      root = createRoot(node)
    }
    root.render(
      <ThemeProvider>
        <Harness {...props} />
      </ThemeProvider>
    )
    await delay(10)
  })
}
async function tap(): Promise<void> {
  await act(async () => {
    note?.handlePress()
    await delay(10)
  })
}

/** Resolves every song to a handle named for its provider id. */
const found = async (tune: WalkUpSong): Promise<string> =>
  `content://${tune.providerId}`

describe('useWalkUpNote', () => {
  it('shows only once the song is found, for a batter with a song, ready, before any pitch', async () => {
    const music = fakeMusic()
    let answer: ((handle: string | null) => void) | undefined
    const asked: Array<{ teamId: string; userId: string }> = []
    const options: WalkUpNoteOptions = {
      resolve: async (_tune, owner) => {
        asked.push(owner)
        return await new Promise(resolve => {
          answer = resolve
        })
      }
    }
    await show({ session: game(0, 2), music, options })
    expect(asked).deep.equals([{ teamId: 'tem_t', userId: '102' }])
    expect(note?.shown).equals(false)
    await act(async () => {
      answer?.('content://tom')
      await delay(10)
    })
    expect(note?.shown).equals(true)
    expect(note?.dimmed).equals(false)
    expect(note?.batterName).equals('Tom B')

    await show({ session: game(0, 2), music, options, phase: 'trajectory' })
    expect(note?.shown).equals(false)
    await show({ session: game(0, 2, [pitch]), music, options })
    expect(note?.shown).equals(false)
    await show({ session: game(0, 1), music, options })
    expect(note?.shown).equals(false)
    await show({ session: game(0, 4), music, options })
    expect(note?.shown).equals(false)
    await show({ session: noPlay, music, options })
    expect(note?.shown).equals(false)
    await tap()
    expect(music.played).deep.equals([])
    // The batter without a song, the guest and no play asked for nothing.
    expect(asked).length(1)
  })

  it('never shows, or looks, without music on this phone', async () => {
    let asked = 0
    await show({
      session: game(0, 2),
      music: NO_WALK_UP_MUSIC,
      options: {
        resolve: async () => {
          asked++
          return 'content://tom'
        }
      }
    })
    expect(note?.shown).equals(false)
    expect(asked).equals(0)
  })

  it('finds the song through the music search by default', async () => {
    const music = fakeMusic([
      {
        ...tomSong,
        source: 'device',
        handle: 'content://media/7'
      }
    ])
    await show({ session: game(0, 2), music })
    expect(music.searches).deep.equals(['walk this way band'])
    expect(note?.shown).equals(true)
    await tap()
    expect(music.played[0].handle).equals('content://media/7')
  })

  it('treats an announced pinch hitter as a new batter with his own song', async () => {
    const music = fakeMusic()
    const asked: string[] = []
    const options: WalkUpNoteOptions = {
      resolve: async (tune, owner) => {
        asked.push(owner.userId)
        return await found(tune)
      }
    }
    await show({ session: game(3, 2), music, options })
    await tap()
    expect(music.played.map(play => play.handle)).deep.equals([
      'content://lf:000000000000000b'
    ])
    await show({ session: game(3, 3, [pinchHit(3, 2)]), music, options })
    expect(asked).deep.equals(['102', '103'])
    expect(note?.shown).equals(true)
    expect(note?.batterName).equals('Pete C')
    expect(note?.playing).equals(false)
    // The announcement is not a pitch: Tom's song is left alone.
    expect(music.stops).deep.equals([])
    await tap()
    expect(music.played.map(play => play.handle)).deep.equals([
      'content://lf:000000000000000b',
      'content://lf:000000000000000c'
    ])
    expect(note?.playing).equals(true)
  })

  it('plays from the start on a tap, and fades out on a second', async () => {
    const music = fakeMusic()
    await show({ session: game(0, 2), music, options: { resolve: found } })
    await tap()
    expect(music.played).deep.equals([
      {
        handle: 'content://lf:000000000000000b',
        startMs: 10000,
        endMs: 25000,
        fade: { inMs: 1500, outMs: 1500 }
      }
    ])
    expect(note?.playing).equals(true)
    await tap()
    expect(music.stops).deep.equals([1500])
    expect(note?.playing).equals(false)
  })

  it('fades out over 1.5 s at the first pitch, and Undo shows it idle until a tap', async () => {
    const music = fakeMusic()
    const options = { resolve: found }
    await show({ session: game(0, 2), music, options })
    await tap()
    await show({ session: game(0, 2, [pitch]), music, options })
    expect(music.stops).deep.equals([1500])
    expect(note?.shown).equals(false)
    expect(note?.playing).equals(false)

    // Undo, back to before the pitch: the note, idle, and no song.
    await show({ session: game(0, 2), music, options })
    expect(note?.shown).equals(true)
    expect(note?.playing).equals(false)
    await act(async () => {
      await delay(50)
    })
    expect(music.played).length(1)
    await tap()
    expect(music.played).length(2)
    expect(music.played[1].startMs).equals(10000)
  })

  it('fades out when the appearance ends, not at a pitch nobody played to', async () => {
    const music = fakeMusic()
    const options = { resolve: found }
    await show({ session: game(0, 2), music, options })
    await show({ session: game(0, 2, [pitch]), music, options })
    expect(music.stops).deep.equals([])
    await show({ session: game(1, 1), music, options })
    await show({ session: game(1, 2), music, options })
    // Straight to the next play with the song playing.
    await tap()
    await show({ session: game(2, 1), music, options })
    expect(music.stops).deep.equals([1500])
  })

  it('shows again when the order bats around to the same batter', async () => {
    const music = fakeMusic()
    let asked = 0
    const options: WalkUpNoteOptions = {
      resolve: async tune => {
        asked++
        return await found(tune)
      }
    }
    await show({ session: game(1, 2), music, options })
    await show({ session: game(1, 2, [pitch]), music, options })
    expect(note?.shown).equals(false)
    await show({ session: game(10, 2), music, options })
    expect(note?.shown).equals(true)
    expect(asked).equals(2)
  })

  it('clears when the song ends by itself, and stops when the screen goes', async () => {
    const music = fakeMusic()
    await show({ session: game(0, 2), music, options: { resolve: found } })
    await tap()
    await act(async () => {
      music.emit({ kind: 'idle' })
      await delay(10)
    })
    expect(note?.playing).equals(false)
    await tap()
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(music.stops).deep.equals([0])
  })

  it('stops at once when the screen starts to leave, and only when playing', async () => {
    const music = fakeMusic()
    await show({ session: game(0, 2), music, options: { resolve: found } })
    await act(async () => {
      note?.stop()
    })
    expect(music.stops).deep.equals([])
    await tap()
    await act(async () => {
      note?.stop()
      await delay(10)
    })
    expect(music.stops).deep.equals([0])
    expect(note?.playing).equals(false)
  })

  it('is dimmed when the song is not on this phone, and a tap shows the toast', async () => {
    const music = fakeMusic()
    await show({
      session: game(0, 2),
      music,
      options: { resolve: async () => null, toastMs: 40 }
    })
    expect(note?.shown).equals(true)
    expect(note?.dimmed).equals(true)
    expect(note?.toast).equals(null)
    await tap()
    expect(note?.toast).equals('Walk This Way isn’t on this phone')
    expect(music.played).deep.equals([])
    await act(async () => {
      await delay(80)
    })
    expect(note?.toast).equals(null)
  })

  it('is dimmed when looking for the song fails', async () => {
    await show({
      session: game(0, 2),
      music: fakeMusic(),
      options: {
        resolve: async () => {
          throw new Error('no access')
        }
      }
    })
    expect(note?.shown).equals(true)
    expect(note?.dimmed).equals(true)
  })
})
