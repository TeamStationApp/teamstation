import { useCallback, useEffect, useRef, useState } from 'react'

import type { RosterEntry } from '../../common/api'
import { battersOf } from '../../common/scoring/rules'
import type { GameState } from '../../common/scoring/state'
import type { WalkUpSong } from '../../common/walkUpSong'
import { lstrings, sprintf } from '../locales/strings'
import { resolveSong, type SongOwner } from './resolveSong'
import { useSongPlayer } from './useSongPlayer'
import type { WalkUpMusic } from './walkUpMusicTypes'

/** Each team's roster, by team id, as the scoring screen read it. */
export type WalkUpRosters = Readonly<Record<string, readonly RosterEntry[]>>

/** What the note needs of the scoring screen: its phase and the game. */
export interface WalkUpNoteScoring {
  phase: string
  session: GameState
}

export interface WalkUpNoteOptions {
  /** Finds a song on this phone; `resolveSong` through `music` otherwise. */
  resolve?: (song: WalkUpSong, owner: SongOwner) => Promise<string | null>
  /** Whether an Apple Music clip fades on the phone's volume. */
  fadeAppleMusic?: boolean
  /** How long the "not on this phone" toast stays. 2.5 s. */
  toastMs?: number
}

export interface WalkUpNote {
  /** Whether the scoring screen shows the note at all. */
  shown: boolean
  /** The batter's name, for the button's label. */
  batterName: string
  /** This batter's clip is playing: the note is a stop button. */
  playing: boolean
  /** The song is not on this phone: the note is dimmed and a tap says so. */
  dimmed: boolean
  /** "‹title› isn't on this phone", after a tap on a dimmed note. */
  toast: string | null
  handlePress: () => void
  /**
   * Stops the song at once, for a screen on its way out: leaving can wait on
   * a save, and the song must not play on while it does.
   */
  stop: () => void
}

/** Music for a screen given none: nothing to find and nothing to play. */
export const NO_WALK_UP_MUSIC: WalkUpMusic = {
  available: false,
  djSupported: false,
  providerName: '',
  access: async () => 'unavailable',
  search: async () => [],
  pickFile: async () => null,
  play: async () => undefined,
  stop: async () => undefined,
  onState: () => () => undefined
}

const TOAST_MS = 2500
/** How long the first pitch's stop fades the song out. */
export const FIRST_PITCH_FADE_MS = 1500

/**
 * The scoring screen's music note: the batter coming up's walk-up song, one
 * tap away, until the first pitch.
 *
 * Each appearance is keyed by its at-bat and its batter — the last of
 * `battersOf`, so a pinch hitter announced before the first pitch is a new
 * batter with his own song. The note shows while the screen is ready for a
 * pitch, the play holds nothing but substitutions, this phone plays music,
 * and the batter has a song on his team. The song is looked for on this
 * phone as soon as the batter changes, and the note shows once that is
 * answered: bright when it was found, dimmed when it was not, where a tap
 * says why.
 *
 * A tap plays the clip from its start and a second tap fades it out over
 * 1.5 s, the same as the end of the clip. The first pitch, or anything else
 * the play records that is not a substitution, fades it out over 1.5 s; so
 * does the end of the appearance. Undo back to before the first pitch shows
 * the note again, idle: nothing plays until the
 * next tap, which starts the clip from its start. Leaving the screen stops it
 * at once, and so does `stop`, which the screen calls as it starts to leave.
 * The scoring sounds' setting has no say.
 */
export function useWalkUpNote(
  scoring: WalkUpNoteScoring,
  rosters: WalkUpRosters,
  music: WalkUpMusic,
  options: WalkUpNoteOptions = {}
): WalkUpNote {
  const { resolve, fadeAppleMusic = true, toastMs = TOAST_MS } = options
  const player = useSongPlayer(music, fadeAppleMusic)
  const { session, phase } = scoring
  const play = session.liveData.plays.currentPlay ?? null
  const batters = play == null ? [] : battersOf(play)
  const batterId = batters.length === 0 ? null : batters[batters.length - 1]
  const batter =
    batterId == null ? undefined : session.gameData.players[batterId]
  const song =
    batter?.userId == null
      ? null
      : (rosters[batter.teamId]?.find(entry => entry.userId === batter.userId)
          ?.walkUpSong ?? null)
  const appearance =
    play == null || batterId == null
      ? null
      : `${play.about.atBatIndex}:${batterId}`
  const fresh =
    play?.playEvents.every(event => event.isSubstitution === true) === true
  // The song as this appearance looks for it: a new batter, or a changed
  // song, looks again.
  const lookup =
    appearance == null || song == null || batter?.userId == null
      ? null
      : `${appearance}|${batter.teamId}:${batter.userId}:${song.provider}:${song.providerId}`

  const [found, setFound] = useState<{
    lookup: string
    handle: string | null
  }>()
  const asking = useRef({ song, batter })
  asking.current = { song, batter }
  useEffect(() => {
    const { song: tune, batter: who } = asking.current
    if (!music.available || lookup == null || tune == null || who == null)
      return
    let live = true
    const owner = { teamId: who.teamId, userId: String(who.userId) }
    const looking =
      resolve == null ? resolveSong(music, tune, owner) : resolve(tune, owner)
    looking
      .then(handle => {
        if (live) setFound({ lookup, handle })
      })
      .catch(() => {
        if (live) setFound({ lookup, handle: null })
      })
    return () => {
      live = false
    }
  }, [lookup, music, resolve])
  const answer = found?.lookup === lookup ? found : undefined

  // The walk-up is over at the first pitch, or when the appearance ends
  // without one: whatever the note started fades out. A substitution, such
  // as a pinch hitter's announcement, is not a pitch.
  const was = useRef({ fresh, atBat: play?.about.atBatIndex })
  const playingRef = useRef(player.playing)
  playingRef.current = player.playing
  const { stop } = player
  useEffect(() => {
    const atBat = play?.about.atBatIndex
    const over = (was.current.fresh && !fresh) || was.current.atBat !== atBat
    was.current = { fresh, atBat }
    if (over && playingRef.current != null) stop(FIRST_PITCH_FADE_MS)
  }, [fresh, play?.about.atBatIndex, stop])

  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    setToast(null)
  }, [appearance])
  useEffect(() => {
    if (toast == null) return
    const timer = setTimeout(() => {
      setToast(null)
    }, toastMs)
    return () => {
      clearTimeout(timer)
    }
  }, [toast, toastMs])

  const handle = answer?.handle ?? null
  const { toggle } = player
  const handlePress = useCallback(() => {
    if (song == null || appearance == null || answer == null) return
    if (handle == null) {
      setToast(sprintf(lstrings.dj_not_here, song.title))
      return
    }
    toggle({
      key: appearance,
      handle,
      provider: song.provider,
      startMs: song.startMs,
      endMs: song.endMs
    })
  }, [song, appearance, answer, handle, toggle])

  const stopNow = useCallback(() => {
    if (playingRef.current != null) stop(0)
  }, [stop])

  return {
    shown:
      music.available &&
      phase === 'ready' &&
      fresh &&
      song != null &&
      answer != null,
    batterName: batter?.fullName ?? '',
    playing: appearance != null && player.playing === appearance,
    dimmed: answer != null && handle == null,
    toast,
    handlePress,
    stop: stopNow
  }
}
