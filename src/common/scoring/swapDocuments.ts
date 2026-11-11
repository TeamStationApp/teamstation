import { storedRecordOf } from './gumbo'
import { type PlaysLost, playsLost } from './playsLost'
import type { SideTeams } from './teamRecord'
import { playSwapped } from './wireRecord'

/**
 * Home and away swapped on a device's own copy of a game, before the
 * server has answered: the game, its lineups and its plays as the server
 * will answer them once the swap lands, and the swap's answer. A pure
 * function of the stored documents, so the phone's queue and the web's
 * screen answer a swap the same way.
 */

type Json = Record<string, unknown>

/** What a swap does: the sides alone, or a reset of the plays first. */
export type SwapDocumentsEffect = 'swap' | 'reset'

/** A swap's answer, as `POST /games/:id/swap-sides` gives it. */
export interface SwappedAnswer {
  homeTeamId: string
  awayTeamId: string
  generation: number
  reset: PlaysLost
}

export interface SwappedDocuments {
  game: Json
  lineups: Json | null
  events: Json | null
  answer: SwappedAnswer
}

/** Where the server puts a game's pregame lineups: the top of the 1st. */
const PREGAME_ABOUT = {
  atBatIndex: 0,
  inning: 1,
  halfInning: 'top',
  isTopInning: true,
  isComplete: false,
  hasOut: false,
  hasReview: false
} as const

const isJson = (value: unknown): value is Json =>
  value != null && typeof value === 'object' && !Array.isArray(value)

/** Whether `value` is something kept by side: `{ away, home }` and nothing else. */
function bySide(value: unknown): value is { away: unknown; home: unknown } {
  if (!isJson(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === 2 && keys[0] === 'away' && keys[1] === 'home'
}

/** `value` with what it keeps of home given to away, and away's to home. */
function exchanged(value: Json): Json {
  const out: Json = {}
  for (const [key, item] of Object.entries(value)) {
    const home = /^home(.*)$/.exec(key)
    const away = /^away(.*)$/.exec(key)
    const pair =
      home != null ? `away${home[1]}` : away != null ? `home${away[1]}` : null
    if (pair != null && pair in value) out[pair] = item
    else if (bySide(item)) out[key] = { away: item.home, home: item.away }
    else out[key] = item
  }
  return out
}

/**
 * The game's teams by side, as its stored game names them, or null when it
 * does not name two: a record is read by side under these.
 */
function teamsOf(game: Json): SideTeams | null {
  const away = game.awayTeamId
  const home = game.homeTeamId
  return typeof away === 'string' &&
    typeof home === 'string' &&
    away !== '' &&
    home !== '' &&
    away !== home
    ? { away: { id: away }, home: { id: home } }
    : null
}

/**
 * A stored play, a row holding one, or an at-bat, with its record's sides
 * exchanged as the server's swap leaves it (`playSwapped`): every lineup,
 * lineup change and confirmed or unseen side goes with its team.
 */
function swappedPlay(item: unknown, teams: SideTeams | null): unknown {
  if (teams == null || !isJson(item)) return item
  if ('gumbo' in item) return { ...item, gumbo: playSwapped(item.gumbo, teams) }
  return playSwapped(item, teams)
}

/** The gumbo plays a stored events document holds, and its at-bat in progress. */
function playsOf(events: Json | null): {
  plays: unknown[]
  currentPlay: unknown
} {
  const rows = Array.isArray(events?.plays) ? events.plays : []
  return {
    plays: rows.map(row => (isJson(row) && 'gumbo' in row ? row.gumbo : row)),
    currentPlay: events?.currentPlay ?? null
  }
}

/**
 * The lineup record a game began with, from its first TeamStation record:
 * its lineup actions before anything else, as the server rewinds a reset
 * game to (`lineupsBefore`).
 */
function lineupsBefore(play: unknown): unknown {
  if (storedRecordOf(play) == null) return null
  const raw = (play as { teamStation: Json }).teamStation
  const actions = Array.isArray(raw.actions) ? raw.actions : []
  const first = actions.findIndex(
    action => (action as { type?: unknown } | null)?.type !== 'lineup'
  )
  const count = first < 0 ? actions.length : first
  const { playbackTimes: _playback, detail: _detail, ...kept } = raw
  return {
    ...kept,
    actions: actions.slice(0, count),
    ...(Array.isArray(raw.actionTimes)
      ? { actionTimes: raw.actionTimes.slice(0, count) }
      : {})
  }
}

/** The game's play generation as the stored documents last had it. */
function generationOf(game: Json, events: Json | null): number {
  const value = events?.generation ?? game.generation
  return typeof value === 'number' ? value : 0
}

/**
 * The stored game, lineups and events with home and away exchanged (each
 * play's record by side too, as the server answers it after the swap), and
 * for `reset` the plays and their tags gone, the game back before its first
 * pitch, and its generation one on; with the swap's answer, whose `reset`
 * names the at-bats and innings the stored plays lose. `localDigest` stands
 * for the lineups digest the server will give the new sides.
 */
export function swappedDocuments(
  stored: { game: Json; lineups: Json | null; events: Json | null },
  effect: SwapDocumentsEffect,
  localDigest: string
): SwappedDocuments {
  const reset = effect === 'reset'
  const teams = teamsOf(stored.game)
  const before = generationOf(stored.game, stored.events)
  const generation = before + (reset ? 1 : 0)
  const shown = playsOf(stored.events)
  const lost: PlaysLost = reset ? playsLost(shown) : { atBats: 0, innings: 0 }
  let game = exchanged(stored.game)
  if ('generation' in stored.game || reset) game = { ...game, generation }
  if (reset)
    game = {
      ...game,
      status: stored.game.status === 'cancelled' ? 'cancelled' : 'scheduled',
      homeScore: null,
      awayScore: null,
      ...('linescore' in game ? { linescore: null } : {})
    }
  const lineups =
    stored.lineups == null
      ? null
      : (() => {
          const swapped = exchanged(stored.lineups)
          const side = (raw: unknown): unknown =>
            !reset || !isJson(raw)
              ? raw
              : {
                  ...raw,
                  start: null,
                  changes: [],
                  current: raw.start ?? raw.current ?? null
                }
          return {
            ...swapped,
            away: side(swapped.away),
            home: side(swapped.home),
            digest: localDigest,
            ...('generation' in stored.lineups || reset ? { generation } : {})
          }
        })()
  const events =
    stored.events == null
      ? null
      : reset
        ? (() => {
            const first = [...shown.plays, shown.currentPlay].find(
              play => storedRecordOf(play) != null
            )
            const pregame = first == null ? null : lineupsBefore(first)
            return {
              ...stored.events,
              plays: [],
              currentPlay:
                pregame == null
                  ? null
                  : swappedPlay(
                      { about: { ...PREGAME_ABOUT }, teamStation: pregame },
                      teams
                    ),
              playsDigest: null,
              priorPlaysDigest: null,
              lineupsDigest: localDigest,
              generation,
              swap: 'swap'
            }
          })()
        : {
            ...stored.events,
            ...(Array.isArray(stored.events.plays)
              ? {
                  plays: stored.events.plays.map(row => swappedPlay(row, teams))
                }
              : {}),
            ...('currentPlay' in stored.events
              ? { currentPlay: swappedPlay(stored.events.currentPlay, teams) }
              : {}),
            lineupsDigest: localDigest
          }
  const homeTeamId = String(game.homeTeamId)
  const awayTeamId = String(game.awayTeamId)
  return {
    game,
    lineups,
    events,
    answer: { homeTeamId, awayTeamId, generation, reset: lost }
  }
}
