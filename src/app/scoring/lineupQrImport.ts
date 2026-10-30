import type { RosterEntry } from '../../common/api'
import type { PlayerNamePrivacy } from '../../common/playerNamePrivacy'
import { JERSEY_MAX_LENGTH } from '../../common/playerSettings'
import { asGumboId } from '../../common/userId'
import type { GameChangerLineup, GameChangerPlayer } from './lineupQrCodec'
import {
  addPlayerDraft,
  addRosteredPlayer,
  emptyPlayerDraft,
  type PlayerDraft
} from './playerDraft'
import { copyState } from './scoringMachine'
import type {
  Position,
  ScoringPlayer,
  ScoringSessionState,
  Side
} from './scoringTypes'

/** GameChanger's position codes for the nine places on the field. */
export const FIELD_CODES: Readonly<Record<number, Position>> = {
  1: '1B',
  2: '2B',
  3: '3B',
  4: 'P',
  5: 'C',
  6: 'CF',
  7: 'LF',
  8: 'RF',
  10: 'SS'
}

/** The place a code puts a player on the field; Roamer, EH and DH have none. */
export function fieldPosition(code: number): Position | undefined {
  return FIELD_CODES[code >= 100 ? code - 100 : code]
}

export interface LineupQrResult {
  draft: ScoringSessionState
  /** Game-only guests the code made. */
  added: string[]
  /** Players already on the team whom the code placed. */
  reused: string[]
  /** Players the code took out of the order and off the field. */
  benched: string[]
}

/** Accents stripped, lowercased, one space between words. */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** A scanned jersey as TeamStation stores one: one to three digits, or none. */
export function scannedJersey(jersey: string): string {
  const digits = jersey.trim().replace(/^#/, '').trim()
  return new RegExp(`^\\d{1,${JERSEY_MAX_LENGTH}}$`).test(digits) ? digits : ''
}

/**
 * Whether a TeamStation short name ("Jordan P", or "Jordan Pu" where two
 * would collide) is this first name and the start of this last name.
 */
function shortNameMatches(
  short: string,
  first: string,
  last: string,
  format: PlayerNamePrivacy | undefined
): boolean {
  const name = fold(short)
  // A format that abbreviates the first name: each word starts its part.
  if (format === 'initials' || format === 'initialLast') {
    const [given = '', family = ''] = name.split(' ')
    return (
      given !== '' &&
      family !== '' &&
      fold(first).startsWith(given) &&
      fold(last).startsWith(family)
    )
  }
  const lead = fold(first) + ' '
  if (!name.startsWith(lead)) return false
  const rest = name.slice(lead.length)
  return rest !== '' && !rest.includes('.') && fold(last).startsWith(rest)
}

function namesMatch(
  scanned: GameChangerPlayer,
  parts: { firstName?: string | null; lastName?: string | null },
  name: string,
  format: PlayerNamePrivacy | undefined
): boolean {
  const full = fold(`${scanned.f} ${scanned.l}`)
  const hasParts =
    `${parts.firstName ?? ''}${parts.lastName ?? ''}`.trim() !== ''
  if (
    hasParts &&
    fold(`${parts.firstName ?? ''} ${parts.lastName ?? ''}`) === full
  )
    return true
  if (fold(name) === full) return true
  return !hasParts && shortNameMatches(name, scanned.f, scanned.l, format)
}

const nameOf = (player: ScoringPlayer): string => player.fullName

/** A roster name, or the scanned one where the roster's is missing or empty. */
const given = (name: string | null | undefined, scanned: string): string =>
  name == null || name.trim() === '' ? scanned : name

function draftOfEntry(
  entry: RosterEntry,
  scanned: GameChangerPlayer,
  jersey: string
): PlayerDraft {
  const empty = emptyPlayerDraft()
  return {
    firstName: given(entry.nameDetails?.firstName, scanned.f.trim()),
    lastName: given(entry.nameDetails?.lastName, scanned.l.trim()),
    jersey: entry.jersey?.trim() ?? jersey,
    bats: entry.bats ?? empty.bats,
    throws: entry.throws ?? empty.throws,
    positions: [...entry.positions]
  }
}

/** Makes a game-only guest on one side of the game, as the server stores one. */
export type CreateGuest = (
  side: Side,
  player: PlayerDraft
) => Promise<RosterEntry>

/** A guest the server could not make; the scorer scans the code again. */
export class LineupQrGuestError extends Error {
  constructor(cause: unknown) {
    super('Unable to create a scanned player', { cause })
  }
}

/**
 * Loads a scanned GameChanger lineup into one side of a roster draft, which
 * stays unsaved until Save Rosters. A scanned player is a player already on
 * the team only when his jersey and name match exactly, so a code scanned
 * twice changes nothing the second time; anyone else is made a game-only
 * guest through `createGuest`. Each scanned batter takes his slot in the
 * order, and each fielder his place; whoever held that slot or place goes to
 * the bench, out of the order and off the field. Everyone else keeps where he
 * was.
 *
 * `created` holds the guests made so far, by their place in the code, so a
 * scan retried after a failed request does not make the earlier ones again.
 */
export async function applyLineupQr(
  draft: ScoringSessionState,
  side: Side,
  lineup: GameChangerLineup,
  roster: readonly RosterEntry[],
  createGuest: CreateGuest | undefined,
  created = new Map<string, RosterEntry>()
): Promise<LineupQrResult> {
  const state = copyState(draft)
  const team = state.liveData.boxscore.teams[side]
  const added: string[] = []
  const reused: string[] = []
  const claimed = new Set<number>()

  const resolveId = async (
    scanned: GameChangerPlayer,
    index: number
  ): Promise<number> => {
    const jersey = scannedJersey(scanned.n)
    const existing = team.players.find(id => {
      const player = state.gameData.players[id]
      return (
        !claimed.has(id) &&
        player.jersey.trim() === jersey &&
        namesMatch(scanned, player, player.fullName, player.nameFormat)
      )
    })
    if (existing != null) {
      reused.push(nameOf(state.gameData.players[existing]))
      return existing
    }
    const entry = roster.find(
      entry =>
        entry.isPlayer &&
        entry.gumboId != null &&
        !claimed.has(entry.gumboId) &&
        (entry.jersey?.trim() ?? '') === jersey &&
        namesMatch(
          scanned,
          entry.nameDetails ?? {},
          entry.shortName,
          entry.nameFormat
        )
    )
    if (entry?.gumboId != null) {
      // Already in the game (his game jersey or name differs from the
      // roster's): placed as he is, his unsaved edits kept.
      if (team.players.includes(entry.gumboId)) {
        reused.push(nameOf(state.gameData.players[entry.gumboId]))
        return entry.gumboId
      }
      const id = addRosteredPlayer(
        state,
        side,
        entry,
        draftOfEntry(entry, scanned, jersey)
      )
      reused.push(nameOf(state.gameData.players[id]))
      return id
    }
    const player = {
      ...emptyPlayerDraft(),
      firstName: scanned.f.trim(),
      lastName: scanned.l.trim(),
      jersey
    }
    const key = JSON.stringify([side, index, player])
    let guest = created.get(key)
    if (guest == null) {
      if (createGuest == null)
        throw new LineupQrGuestError(new Error('Unable to create a guest'))
      try {
        guest = await createGuest(side, player)
      } catch (error) {
        throw new LineupQrGuestError(error)
      }
      created.set(key, guest)
    }
    const id = addPlayerDraft(state, side, player, asGumboId(guest.gumboId))
    added.push(nameOf(state.gameData.players[id]))
    return id
  }

  const resolveAll = async (
    players: readonly GameChangerPlayer[],
    offset: number
  ): Promise<Array<{ id: number; scanned: GameChangerPlayer }>> => {
    const resolved = []
    for (const [index, scanned] of players.entries()) {
      const id = await resolveId(scanned, offset + index)
      claimed.add(id)
      resolved.push({ id, scanned })
    }
    return resolved
  }
  const batters = await resolveAll(lineup.h, 0)
  const fielders = await resolveAll(lineup.n, lineup.h.length)
  const scanned = new Set(claimed)
  const bench = new Set<number>()

  const order = team.battingOrder
  for (const id of order.slice(0, batters.length))
    if (!scanned.has(id)) bench.add(id)
  team.battingOrder = [
    ...batters.map(batter => batter.id),
    ...order.slice(batters.length).filter(id => !scanned.has(id))
  ]

  for (const position of Object.keys(team.defense) as Position[]) {
    const holder = team.defense[position]
    if (holder != null && scanned.has(holder)) team.defense[position] = null
  }
  for (const { id, scanned: player } of [...batters, ...fielders]) {
    const position = fieldPosition(player.p)
    if (position == null) continue
    // A scanned player who already took this place (a half-built code can
    // name two pitchers) loses it to the later one but stays in the order.
    const holder = team.defense[position]
    if (holder != null && !scanned.has(holder)) bench.add(holder)
    team.defense[position] = id
  }

  for (const id of bench) {
    team.battingOrder = team.battingOrder.filter(other => other !== id)
    for (const position of Object.keys(team.defense) as Position[])
      if (team.defense[position] === id) team.defense[position] = null
  }
  // A fielder who does not bat and found no place (a Roamer, or a place a
  // later player took) is on the bench, and is counted there.
  const fielding = new Set(Object.values(team.defense))
  for (const { id } of fielders)
    if (!fielding.has(id) && !team.battingOrder.includes(id)) bench.add(id)
  return {
    draft: state,
    added,
    reused,
    benched: [...bench].map(id => nameOf(state.gameData.players[id]))
  }
}
