import { shortName } from '../../common/names'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { POSITIONS } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'

/**
 * What a queued write does to the phone's copy before the server has seen
 * it: the same documents the server would answer, worked out on the phone.
 * Each takes and returns the JSON the documents hold, as the server sent it.
 */

/** A digest made on the phone. It is never sent to the server. */
export const LOCAL_PREFIX = 'local-'

export const isLocal = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(LOCAL_PREFIX)

type Json = Record<string, unknown>

const objectOf = (raw: unknown): Json =>
  raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Json)
    : {}

const arrayOf = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : [])

/**
 * `GET /games/:gameId/lineups` once one side's lineup is saved: that side's
 * lineup as it stands replaced from the save, the other side as it was, and
 * `digest` the phone's own.
 */
export function appliedLineups(
  document: unknown,
  save: unknown,
  digest: string
): Json {
  const lineups = objectOf(document)
  const body = objectOf(save)
  const side = body.side === 'home' ? 'home' : 'away'
  const players = arrayOf(body.players).map(objectOf)
  const person = (index: unknown): Json | null => {
    const player = typeof index === 'number' ? players[index] : undefined
    return player == null
      ? null
      : {
          gumboId: player.gumboId ?? null,
          name: typeof player.fullName === 'string' ? player.fullName : '',
          jersey: typeof player.jersey === 'string' ? player.jersey : ''
        }
  }
  const defense = objectOf(body.defense)
  const current = {
    batters: arrayOf(body.battingOrder).map(person),
    defense: Object.fromEntries(
      POSITIONS.map(position => [position, person(defense[position])])
    )
  }
  return {
    ...lineups,
    [side]: { ...objectOf(lineups[side]), current },
    digest
  }
}

/** A play's place in the game. */
function indexOf(play: unknown): number | undefined {
  const index = objectOf(objectOf(play).about).atBatIndex
  return typeof index === 'number' ? index : undefined
}

/**
 * `GET /games/:gameId/events` once a live post is written: its plays in
 * place by `atBatIndex`, the indexes in `remove` gone, and the at-bat in
 * progress replaced when the post names one. `priorPlaysDigest` is the
 * document's before, as the server answers a post.
 */
export function appliedEvents(
  document: unknown,
  post: unknown,
  game: {
    gameId: string
    plays: string
    lineups: string | null
    newPlayId: () => string
  }
): Json {
  const stored = objectOf(document)
  const body = objectOf(post)
  const rows = new Map<number, Json>()
  for (const raw of arrayOf(stored.plays)) {
    const row = objectOf(raw)
    const index = indexOf(row.gumbo)
    if (index != null) rows.set(index, row)
  }
  for (const index of arrayOf(body.remove))
    if (typeof index === 'number') rows.delete(index)
  for (const play of arrayOf(body.plays)) {
    const index = indexOf(play)
    if (index == null) continue
    const held = rows.get(index)
    rows.set(index, {
      ...held,
      id: held?.id ?? game.newPlayId(),
      gameId: held?.gameId ?? game.gameId,
      gumbo: play
    })
  }
  return {
    ...stored,
    plays: [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row),
    currentPlay:
      body.currentPlay === undefined
        ? (stored.currentPlay ?? null)
        : body.currentPlay,
    priorPlaysDigest: stored.playsDigest ?? null,
    playsDigest: game.plays,
    lineupsDigest: game.lineups
  }
}

/**
 * The roster entry of a player made on the phone, as `GET
 * /teams/:teamId/roster` would list him: with his whole name only on the
 * roster a manager reads (`full`). His ids are the phone's until the server
 * makes him.
 */
export function localRosterEntry(
  localId: number,
  player: NewRosterPlayer,
  full: boolean
): Json {
  const named = [player.firstName, player.lastName]
    .filter(part => part !== '')
    .join(' ')
  const displayName = named === '' ? 'Player' : named
  return {
    userId: userIdOfGumbo(localId),
    gumboId: localId,
    ...(full
      ? {
          nameDetails: {
            firstName: player.firstName,
            lastName: player.lastName,
            displayName
          }
        }
      : {}),
    bats: player.bats,
    throws: player.throws,
    shortName: shortName({
      id: localId,
      firstName: player.firstName,
      lastName: player.lastName,
      displayName
    }),
    avatarUrl: null,
    jersey: player.jersey,
    positions: [...player.positions],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    walkUpSong: null
  }
}

/** A roster entry as the plain roster lists it: no whole name. */
export function plainEntry(entry: unknown): Json {
  const { nameDetails: _, ...plain } = objectOf(entry)
  return plain
}

/** The ids the server gave a player the phone made. */
export interface LandedIds {
  serverId: number
  userId: string | null
}

const GUMBO_KEY = /^ID(\d+)$/
/** A map keyed by gumbo id, as a game's players are: `{ "12": … }`. */
const BARE_KEY = /^(\d+)$/

/**
 * `value` with every id of a player the phone made replaced by the
 * server's: his gumbo id wherever it stands as a number or as a key, his
 * user id, and `ID<gumbo id>` as a key or a value. Only ids in `landed` are
 * touched.
 */
export function withServerIds(
  value: unknown,
  landed: Map<number, LandedIds>
): unknown {
  if (landed.size === 0) return value
  const byUserId = new Map<string, string>()
  for (const [localId, ids] of landed)
    if (ids.userId != null) byUserId.set(userIdOfGumbo(localId), ids.userId)
  const gumboText = (text: string): string => {
    const match = GUMBO_KEY.exec(text)
    const ids = match == null ? undefined : landed.get(Number(match[1]))
    return ids == null ? text : `ID${ids.serverId}`
  }
  const gumboKey = (key: string): string => {
    const bare = BARE_KEY.exec(key)
    const ids = bare == null ? undefined : landed.get(Number(bare[1]))
    return ids == null ? gumboText(key) : String(ids.serverId)
  }
  const walk = (raw: unknown): unknown => {
    if (typeof raw === 'number') return landed.get(raw)?.serverId ?? raw
    if (typeof raw === 'string') return byUserId.get(raw) ?? gumboText(raw)
    if (Array.isArray(raw)) return raw.map(walk)
    if (raw == null || typeof raw !== 'object') return raw
    return Object.fromEntries(
      Object.entries(raw).map(([key, item]) => [gumboKey(key), walk(item)])
    )
  }
  return walk(value)
}

/** The ids of `local` that `value` names anywhere, as `withServerIds` reads. */
export function namedLocalIds(value: unknown, local: Set<number>): number[] {
  const found = new Set<number>()
  const byUserId = new Map(
    [...local].map(localId => [userIdOfGumbo(localId), localId])
  )
  const text = (raw: string): void => {
    const user = byUserId.get(raw)
    if (user != null) found.add(user)
    const match = GUMBO_KEY.exec(raw)
    if (match != null && local.has(Number(match[1])))
      found.add(Number(match[1]))
  }
  const walk = (raw: unknown): void => {
    if (typeof raw === 'number') {
      if (local.has(raw)) found.add(raw)
    } else if (typeof raw === 'string') text(raw)
    else if (Array.isArray(raw)) raw.forEach(walk)
    else if (raw != null && typeof raw === 'object')
      for (const [key, item] of Object.entries(raw)) {
        text(key)
        const bare = BARE_KEY.exec(key)
        if (bare != null && local.has(Number(bare[1])))
          found.add(Number(bare[1]))
        walk(item)
      }
  }
  walk(value)
  return [...found]
}
