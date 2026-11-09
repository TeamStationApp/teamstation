import type { StoredGame } from './session'
import type { GamePlayer } from './state'

/**
 * A game's players as its reader reads them. `GET /games/:gameId/events`
 * names the plays as the public reads them, for every reader, and answers
 * apart (`readerNames`) the players this reader reads in full. Only the
 * game's players change: the play sentences, references and credits stay
 * the shared game record that socket edits extend.
 */

type Json = Record<string, unknown>

function object(value: unknown): value is Json {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A setup player its reader reads in full: `fullName` the full name, drawn
 * as sent (`nameFormat: 'full'`), and the label it replaced kept as
 * `compactName`, in the format it was written in (`compactFormat`). Anyone
 * else, or one already so named, as he is.
 */
function readerPlayer(
  player: unknown,
  names: Readonly<Record<string, string>>
): unknown {
  if (!object(player) || typeof player.id !== 'number') return player
  const name = Object.hasOwn(names, String(player.id))
    ? names[String(player.id)]
    : undefined
  if (name == null || player.fullName === name) return player
  const kept = typeof player.compactName === 'string'
  const { compactFormat: _held, ...rest } = player
  const format = kept ? player.compactFormat : player.nameFormat
  return {
    ...rest,
    fullName: name,
    nameFormat: 'full',
    compactName: kept
      ? player.compactName
      : typeof player.fullName === 'string'
        ? player.fullName
        : '',
    ...(format == null ? {} : { compactFormat: format })
  }
}

function readerSetup(
  setup: unknown,
  names: Readonly<Record<string, string>>
): unknown {
  if (!object(setup) || !object(setup.players)) return setup
  let players: Json | undefined
  for (const [key, player] of Object.entries(setup.players)) {
    const next = readerPlayer(player, names)
    if (next === player) continue
    players ??= { ...setup.players }
    players[key] = next
  }
  return players == null ? setup : { ...setup, players }
}

/**
 * A record's setups — before the play and each action's — as its reader
 * reads them. A version 1 record keys its players by session id, which
 * `readerNames` does not name, so it stays as it is.
 */
function readerRecord(
  record: unknown,
  names: Readonly<Record<string, string>>
): unknown {
  if (!object(record) || record.version === 1) return record
  let out: Json | undefined
  const before = readerSetup(record.setupBefore, names)
  if (before !== record.setupBefore) out = { ...record, setupBefore: before }
  if (Array.isArray(record.actions)) {
    const held: unknown[] = record.actions
    const actions = held.map(action => {
      if (!object(action)) return action
      const setup = readerSetup(action.setup, names)
      return setup === action.setup ? action : { ...action, setup }
    })
    if (actions.some((action, i) => action !== held[i]))
      out = { ...(out ?? record), actions }
  }
  return out ?? record
}

function readerPlay<T>(play: T, names: Readonly<Record<string, string>>): T {
  if (!object(play) || !('teamStation' in play)) return play
  const record = readerRecord(play.teamStation, names)
  return record === play.teamStation ? play : { ...play, teamStation: record }
}

/**
 * `game` with every setup player `readerNames` names (by gumbo id) given his
 * full name: `fullName` the full name, `nameFormat: 'full'`, `compactName`
 * the label it replaced and `compactFormat` its format. The game as it is without any.
 */
export function withReaderNames<T extends StoredGame>(
  game: T,
  readerNames: Readonly<Record<string, string>> | undefined
): T {
  if (readerNames == null || Object.keys(readerNames).length === 0) return game
  const plays = game.plays.map(play => readerPlay(play, readerNames))
  const currentPlay = readerPlay(game.currentPlay, readerNames)
  if (
    currentPlay === game.currentPlay &&
    plays.every((play, i) => play === game.plays[i])
  )
    return game
  return { ...game, plays, currentPlay }
}

/**
 * A player as a reader who may not read his full name reads him: one named
 * in full only for his reader (`compactName`) takes the public label back as
 * `fullName`, in its format (`compactFormat`), without the first and last
 * names he was given. Anyone else as he is.
 */
export function publicPlayer(player: GamePlayer): GamePlayer {
  if (player.compactName == null) return player
  // The parts are his full name too: the label stands alone.
  const {
    compactName,
    compactFormat,
    nameFormat: _nameFormat,
    firstName: _firstName,
    lastName: _lastName,
    ...rest
  } = player
  return {
    ...rest,
    fullName: compactName,
    ...(compactFormat == null ? {} : { nameFormat: compactFormat })
  }
}

/**
 * `game` with every player of a team `hidden` names drawn by his public
 * label (`publicPlayer`): what the app shows while its reader may no longer
 * read the full names `withReaderNames` gave the game it holds. The game as
 * it is when nobody is hidden.
 */
export function withoutReaderNames<
  T extends { gameData: { players: Record<number, GamePlayer> } }
>(game: T, hidden: (teamId: string) => boolean): T {
  let players: Record<number, GamePlayer> | undefined
  for (const [key, player] of Object.entries(game.gameData.players)) {
    if (player.compactName == null || !hidden(player.teamId)) continue
    players ??= { ...game.gameData.players }
    players[Number(key)] = publicPlayer(player)
  }
  return players == null
    ? game
    : { ...game, gameData: { ...game.gameData, players } }
}
