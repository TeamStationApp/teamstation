import { shortName, shortNames } from '../../common/names'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { POSITIONS } from '../../common/scoring/state'
import { namesIn, withNames } from '../../common/scoring/storedNames'
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

/** The names a cached `GET /games/:gameId/events` answer's documents carry. */
function eventsNames(stored: Json): Map<number, string> {
  const names = new Map<number, string>()
  const add = (play: unknown): void => {
    for (const [id, name] of namesIn(play))
      if (!names.has(id)) names.set(id, name)
  }
  for (const row of arrayOf(stored.plays)) add(objectOf(row).gumbo)
  add(stored.currentPlay)
  return names
}

/** A player's first and last names, as a setup holds them. */
interface Halves {
  firstName: string
  lastName: string
}

/** A record's setups: the one before its play, and each action's own. */
function setupsOf(play: unknown): Json[] {
  const record = objectOf(objectOf(play).teamStation)
  return [
    record.setupBefore,
    ...arrayOf(record.actions).map(action => objectOf(action).setup)
  ]
    .map(objectOf)
    .filter(setup => 'players' in setup)
}

/**
 * The first and last names a cached `GET /games/:gameId/events` answer's
 * setups hold, by gumbo id: the server answers them to whoever may correct
 * a side's names, and a post, naming nobody, carries none.
 */
function eventsHalves(stored: Json): Map<number, Halves> {
  const halves = new Map<number, Halves>()
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : ''
  for (const play of [
    ...arrayOf(stored.plays).map(row => objectOf(row).gumbo),
    stored.currentPlay
  ])
    for (const setup of setupsOf(play))
      for (const raw of Object.values(objectOf(setup.players))) {
        const player = objectOf(raw)
        if (
          typeof player.id === 'number' &&
          !halves.has(player.id) &&
          (typeof player.firstName === 'string' ||
            typeof player.lastName === 'string')
        )
          halves.set(player.id, {
            firstName: text(player.firstName),
            lastName: text(player.lastName)
          })
      }
  return halves
}

/** `play` with each setup player whose halves are known holding them. */
function withHalves(
  play: unknown,
  halves: ReadonlyMap<number, Halves>
): unknown {
  const document = objectOf(play)
  if (halves.size === 0 || !('teamStation' in document)) return play
  const record = objectOf(document.teamStation)
  const setup = (raw: unknown): unknown => {
    const held = objectOf(raw)
    if (!('players' in held)) return raw
    const players: Json = {}
    for (const [key, entry] of Object.entries(objectOf(held.players))) {
      const player = objectOf(entry)
      const parts =
        typeof player.id === 'number' && !('firstName' in player)
          ? halves.get(player.id)
          : undefined
      players[key] = parts == null ? entry : { ...player, ...parts }
    }
    return { ...held, players }
  }
  return {
    ...document,
    teamStation: {
      ...record,
      ...('setupBefore' in record
        ? { setupBefore: setup(record.setupBefore) }
        : {}),
      ...(Array.isArray(record.actions)
        ? {
            actions: record.actions.map(action =>
              'setup' in objectOf(action)
                ? { ...objectOf(action), setup: setup(objectOf(action).setup) }
                : action
            )
          }
        : {})
    }
  }
}

/**
 * `GET /games/:gameId/events` once a live post is written: its plays in
 * place by `atBatIndex`, the indexes in `remove` gone, and the at-bat in
 * progress replaced when the post names one. `priorPlaysDigest` is the
 * document's before, as the server answers a post. A post's documents are
 * in their stored form, naming nobody: each is named (`withNames`) from the
 * names kept beside it on the phone (`game.names`), then from those the
 * cached answer already shows, and each setup player keeps the first and
 * last names the cached answer gave him, so a game reopened from it offline
 * still offers them to correct (`draftOfLocalPlayer`).
 */
export function appliedEvents(
  document: unknown,
  post: unknown,
  game: {
    gameId: string
    plays: string
    lineups: string | null
    newPlayId: () => string
    names?: Readonly<Record<string, string>> | null
  }
): Json {
  const stored = objectOf(document)
  const body = objectOf(post)
  const held = eventsNames(stored)
  const halves = eventsHalves(stored)
  const sent = game.names ?? {}
  const nameOf = (id: number): string | undefined =>
    Object.hasOwn(sent, String(id)) ? sent[String(id)] : held.get(id)
  const named = (play: unknown): unknown =>
    play == null ? play : withHalves(withNames(play, nameOf), halves)
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
      gumbo: named(play)
    })
  }
  return {
    ...stored,
    plays: [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row),
    currentPlay:
      body.currentPlay === undefined
        ? (stored.currentPlay ?? null)
        : named(body.currentPlay),
    priorPlaysDigest: stored.playsDigest ?? null,
    playsDigest: game.plays,
    lineupsDigest: game.lineups
  }
}

/**
 * `value` with the player of `gumboId` called `name` wherever it names him
 * by id: each reference and setup player, his first and last names where a
 * setup holds them.
 */
function renamedIn(
  value: unknown,
  gumboId: number,
  name: { fullName: string; firstName: string; lastName: string }
): unknown {
  if (Array.isArray(value))
    return value.map(item => renamedIn(item, gumboId, name))
  if (value == null || typeof value !== 'object') return value
  const out: Json = {}
  for (const [key, item] of Object.entries(value as Json))
    out[key] = renamedIn(item, gumboId, name)
  if (out.id === gumboId && typeof out.fullName === 'string') {
    out.fullName = name.fullName
    if ('firstName' in out || 'lastName' in out) {
      out.firstName = name.firstName
      out.lastName = name.lastName
    }
  }
  return out
}

/**
 * The game's short name for a guest called `name`, as the server will name
 * him: short names over everyone the cached answer names, him by his new
 * halves, the others by the halves its setups hold or else by the names it
 * shows.
 */
function guestShortName(stored: Json, gumboId: number, name: Halves): string {
  const halves = eventsHalves(stored)
  const people = [...eventsNames(stored)]
    .filter(([id]) => id !== gumboId)
    .map(([id, shown]) => ({ id, displayName: shown, ...halves.get(id) }))
  const whole = [name.firstName, name.lastName]
    .filter(part => part !== '')
    .join(' ')
  return (
    shortNames([...people, { id: gumboId, displayName: whole, ...name }]).get(
      gumboId
    ) ?? whole
  )
}

/**
 * `GET /games/:gameId/events` once a game-only player's name is corrected
 * on the phone: every play and the at-bat in progress name him by the
 * game's short name for him (`guestShortName`), their sentences and credits
 * worded again with it, and his setup players hold his new halves.
 */
export function renamedEvents(
  document: unknown,
  gumboId: number,
  name: { firstName: string; lastName: string }
): Json {
  const stored = objectOf(document)
  const short = guestShortName(stored, gumboId, name)
  const his = new Map([[gumboId, name]])
  const renamed = (play: unknown): unknown => {
    if (play == null) return play
    const next = renamedIn(play, gumboId, { ...name, fullName: short })
    const names = namesIn(next)
    return withHalves(
      withNames(next, id => (id === gumboId ? short : names.get(id))),
      his
    )
  }
  return {
    ...stored,
    ...(Array.isArray(stored.plays)
      ? {
          plays: stored.plays.map(raw => {
            const row = objectOf(raw)
            return { ...row, gumbo: renamed(row.gumbo) }
          })
        }
      : {}),
    ...('currentPlay' in stored
      ? { currentPlay: renamed(stored.currentPlay) }
      : {})
  }
}

/**
 * The roster entry of a guest whose name is corrected on the phone, as `PUT
 * /games/:gameId/guest-players/:userId` answers it: his entry in the game's
 * `guestPlayers` with the name he is given, or one made from that name alone.
 */
export function renamedGuestEntry(
  game: unknown,
  userId: string,
  gumboId: number | null,
  name: { firstName: string; lastName: string }
): Json {
  const displayName = [name.firstName, name.lastName]
    .filter(part => part !== '')
    .join(' ')
  const listed = arrayOf(objectOf(game).guestPlayers)
    .map(objectOf)
    .find(entry => entry.userId === userId)
  return {
    jersey: null,
    positions: [],
    bats: null,
    throws: null,
    isPlayer: true,
    role: 'player',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    avatarUrl: null,
    walkUpSong: null,
    ...listed,
    userId,
    gumboId: listed?.gumboId ?? gumboId,
    shortName: displayName,
    nameDetails: { ...name, displayName }
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
