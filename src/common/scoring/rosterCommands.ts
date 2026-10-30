import {
  asArray,
  asBoolean,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from '../asLiteral'
import {
  type Base,
  BASES,
  drawnName,
  type JsonSchema,
  modelNameOf,
  shortName
} from './actions'
import { addPlayer, baseIds, battingSide, begun, ordinal } from './lineup'
import {
  asSessionId,
  copyState,
  type GamePlayer,
  type GameState,
  type Position,
  POSITIONS,
  type Side,
  withoutUndefined
} from './state'

/**
 * A change to a roster, a batting order or a defense that a scorer or a coach
 * says rather than taps. The scoring engine never sees one: a screen applies
 * it to its draft of the lineups, and saving the draft makes the `lineup`
 * actions. `player` is a session player id, as `resolveRosterCommands` finds
 * him from what was said.
 */
export type RosterCommand =
  | {
      type: 'addPlayer'
      side: Side
      name: string
      /** Minted by the caller before this command reaches the pure engine. */
      player?: number
      jersey?: string
      placeholder?: boolean
    }
  | { type: 'setLineup'; side: Side; order: number[] }
  | {
      type: 'placeInLineup'
      side: Side
      places: Array<{ player: number; slot: number | 'end' }>
    }
  | { type: 'pinchHitter'; player: number }
  | { type: 'pinchRunner'; player: number; base: Base }
  | {
      type: 'setPositions'
      side: Side
      places: Array<{ player: number; position: Position }>
    }
export type RosterCommandType = RosterCommand['type']

/**
 * A player as the scorer said him: "number 3" is `{ jersey: '3' }`, "Soto"
 * is `{ name: 'Soto' }`, and "Freeman, number 13" is both.
 */
export interface PlayerSaid {
  jersey?: string
  name?: string
}

/** A roster command's shape, with its players as `P` and its team as said. */
type Said<P> =
  | {
      type: 'addPlayer'
      side?: Side
      name: string
      jersey?: string
      placeholder?: boolean
    }
  | { type: 'setLineup'; side?: Side; order: P[] }
  | {
      type: 'placeInLineup'
      side?: Side
      places: Array<{ player: P; slot: number | 'end' }>
    }
  | { type: 'pinchHitter'; player: P }
  | { type: 'pinchRunner'; player: P; base: Base }
  | {
      type: 'setPositions'
      side?: Side
      places: Array<{ player: P; position: Position }>
    }

/**
 * A roster command as it was said, which is how a dictation model reports
 * one: every player as said, and the team only when the scorer named one.
 * `resolveRosterCommands` finds the players.
 */
export type SaidRosterCommand = Said<PlayerSaid>

/**
 * A said command some of whose players the scorer has chosen among several,
 * each chosen one by his id, and whose team may be settled: what an option of
 * a `RosterQuestion` carries. A resolved `RosterCommand` is one too.
 */
export type ChosenRosterCommand = Said<PlayerSaid | number>

/** A model cannot turn an ordinary creation into a game-only player. */
export function explicitPlaceholders<T extends ChosenRosterCommand>(
  commands: readonly T[],
  transcript: string
): T[] {
  return commands.map(command =>
    command.type === 'addPlayer' &&
    command.placeholder === true &&
    !/\bplaceholders?\b/i.test(transcript)
      ? { ...command, placeholder: false }
      : command
  )
}

export const ROSTER_COMMAND_TYPES = [
  'addPlayer',
  'setLineup',
  'placeInLineup',
  'pinchHitter',
  'pinchRunner',
  'setPositions'
] as const satisfies readonly RosterCommandType[]

/** What a command changes: the roster, the side at bat's order, or the field. */
export type RosterCategory = 'roster' | 'offense' | 'defense'
export const ROSTER_CATEGORY: Record<RosterCommandType, RosterCategory> = {
  addPlayer: 'roster',
  setLineup: 'offense',
  placeInLineup: 'offense',
  pinchHitter: 'offense',
  pinchRunner: 'offense',
  setPositions: 'defense'
}

/** The roster screen's tabs that show each category. */
export type RosterTab = 'editRoster' | 'lineup' | 'defense'
export const ROSTER_TAB: Record<RosterCategory, RosterTab> = {
  roster: 'editRoster',
  offense: 'lineup',
  defense: 'defense'
}

/** A pinch runner the draft holds until it is saved: the order never changes. */
export interface StagedRunner {
  base: Base
  player: number
}

const SIDES = ['away', 'home'] as const satisfies readonly Side[]
const asSide = asLiteral(...SIDES)
const asSlot = (raw: unknown): number | 'end' => {
  if (raw === 'end') return 'end'
  const slot = asSessionId(raw)
  if (slot < 1) throw new TypeError(`Expected a place from 1, got ${slot}`)
  return slot
}
const asPosition = asLiteral(...POSITIONS)

/**
 * The cleaners of each command, given how its players and its team are
 * read: by id and required once resolved, as said and optional before.
 */
function cleanersOf<P, S extends Side | undefined>(
  asPlayer: Cleaner<P>,
  asTeam: Cleaner<S>
): Record<RosterCommandType, Cleaner<unknown>> {
  return {
    addPlayer: asObject({
      type: asLiteral('addPlayer'),
      side: asTeam,
      name: asString,
      jersey: asOptional(asString),
      placeholder: asOptional(asBoolean)
    }),
    setLineup: asObject({
      type: asLiteral('setLineup'),
      side: asTeam,
      order: asArray(asPlayer)
    }),
    placeInLineup: asObject({
      type: asLiteral('placeInLineup'),
      side: asTeam,
      places: asArray(asObject({ player: asPlayer, slot: asSlot }))
    }),
    pinchHitter: asObject({
      type: asLiteral('pinchHitter'),
      player: asPlayer
    }),
    pinchRunner: asObject({
      type: asLiteral('pinchRunner'),
      player: asPlayer,
      base: asLiteral(...BASES)
    }),
    setPositions: asObject({
      type: asLiteral('setPositions'),
      side: asTeam,
      places: asArray(asObject({ player: asPlayer, position: asPosition }))
    })
  }
}

/** Checks one command by its `type` with `cleaners`, and throws on anything else. */
function byType<T>(
  cleaners: Record<RosterCommandType, Cleaner<unknown>>
): Cleaner<T> {
  return (raw: unknown) => {
    const type =
      raw != null && typeof raw === 'object'
        ? (raw as { type?: unknown }).type
        : undefined
    if (
      typeof type !== 'string' ||
      !(ROSTER_COMMAND_TYPES as readonly string[]).includes(type)
    )
      throw new TypeError(
        `Unknown roster command ${JSON.stringify(type ?? null)}`
      )
    return withoutUndefined(cleaners[type as RosterCommandType](raw) as T)
  }
}

/** Checks one resolved roster command, by its `type`, and throws on anything else. */
export const asRosterCommand: Cleaner<RosterCommand> = byType(
  cleanersOf(asSessionId, asSide)
)

/** Words said, trimmed; nothing said, or nothing but space, is absent. */
const asSaidText = (raw: unknown): string | undefined => {
  if (raw == null) return undefined
  const text = (typeof raw === 'number' ? String(raw) : asString(raw)).trim()
  return text === '' ? undefined : text
}
/** A player as said: a number, a name, or both, and never an id. */
const asPlayerSaid: Cleaner<PlayerSaid> = raw => {
  const { jersey, name } = asObject({ jersey: asSaidText, name: asSaidText })(
    raw
  )
  const number = jersey?.replace(/^#\s*/, '')
  if (number == null && name == null)
    throw new TypeError('Expected a player by number or name')
  return withoutUndefined({ jersey: number, name })
}
/** The team as said: absent unless the scorer named one. */
const asSaidSide = (raw: unknown): Side | undefined =>
  raw == null || raw === '' ? undefined : asSide(raw)

/**
 * Checks one roster command as said, by its `type`, and throws on anything
 * else: on the server, what a model reported, and again on the wire.
 */
export const asSaidRosterCommand: Cleaner<SaidRosterCommand> = byType(
  cleanersOf(asPlayerSaid, asSaidSide)
)

/** What the game says about where a command lands. */
export interface RosterSituation {
  /** The game has begun: a pinch hitter or runner may come in. */
  live: boolean
  /** The side at bat, whose players pinch-hit and pinch-run. */
  battingSide: Side
  /** The runner on each base, by session id. */
  runnersOn: Partial<Record<Base, number | null>>
  /** Pinch runners the draft already holds. */
  runners?: readonly StagedRunner[]
  /** The batter the draft already sends up next. */
  nextBatter?: number
}

/** The situation of a game, for commands applied over a draft of it. */
export function rosterSituation(state: GameState): RosterSituation {
  const bases = baseIds(state)
  return {
    live: begun(state),
    battingSide: battingSide(state),
    runnersOn: Object.fromEntries(BASES.map((base, i) => [base, bases[i]]))
  }
}

/** A sentence of commands, staged over a draft. */
export interface StagedRoster {
  draft: GameState
  category: RosterCategory
  side: Side
  /** What the chat says was done, one line a change. */
  lines: string[]
  runners: StagedRunner[]
  nextBatter?: number
}

export const ONE_CATEGORY_AT_A_TIME =
  'Say roster, lineup and defense changes one at a time'
export const ONE_TEAM_AT_A_TIME =
  'Say roster, lineup and defense changes one team at a time'

class Refused extends Error {}
function refuse(message: string): never {
  throw new Refused(message)
}

/**
 * Applies one dictated sentence to a draft of the lineups. Its commands must
 * all change one category and one side, or the whole sentence is refused.
 * Each command is applied in turn to a copy of `draft`; the first refused
 * stops the sentence, and nothing is staged. The draft is left as it was.
 */
export function applyRosterCommands(
  draft: GameState,
  commands: readonly RosterCommand[],
  situation: RosterSituation
): StagedRoster | { problem: string } {
  const scope = rosterCommandScope(commands, situation)
  if ('problem' in scope) return scope
  const { category, side } = scope
  const next = copyState(draft)
  const staged: Staging = {
    state: next,
    side,
    situation,
    lines: [],
    runners: [...(situation.runners ?? [])],
    nextBatter: situation.nextBatter
  }
  try {
    for (const command of commands)
      APPLY[command.type](staged, command as never)
  } catch (error) {
    if (error instanceof Refused) return { problem: error.message }
    throw error
  }
  const order = next.liveData.boxscore.teams[situation.battingSide].battingOrder
  const nextBatter =
    staged.nextBatter != null && order.includes(staged.nextBatter)
      ? staged.nextBatter
      : undefined
  return {
    draft: next,
    category,
    side,
    lines: staged.lines,
    runners: staged.runners,
    ...(nextBatter == null ? {} : { nextBatter })
  }
}

/** Validate a sentence's scope before its persistent player creations begin. */
export function rosterCommandScope(
  commands: readonly RosterCommand[],
  situation: RosterSituation
): { category: RosterCategory; side: Side } | { problem: string } {
  if (commands.length === 0) return { problem: 'Nothing to change' }
  const categories = new Set(
    commands.map(command => ROSTER_CATEGORY[command.type])
  )
  if (categories.size > 1) return { problem: ONE_CATEGORY_AT_A_TIME }
  const sideOf = (command: RosterCommand): Side =>
    'side' in command ? command.side : situation.battingSide
  const sides = new Set(commands.map(sideOf))
  if (sides.size > 1) return { problem: ONE_TEAM_AT_A_TIME }
  const [category] = categories
  const [side] = sides
  return { category, side }
}

interface Staging {
  state: GameState
  side: Side
  situation: RosterSituation
  lines: string[]
  runners: StagedRunner[]
  nextBatter?: number
}

const nameOf = (state: GameState, id: number): string =>
  drawnName(state.gameData.players[id])

/** The player, refused unless he is on the side's roster. */
function member(staging: Staging, id: number): number {
  const { state, side } = staging
  const player = state.gameData.players[id]
  if (
    player == null ||
    !state.liveData.boxscore.teams[side].players.includes(id)
  )
    refuse(
      `${player == null ? `Player ${id}` : drawnName(player)} is not on the ${state.gameData.teams[side].name} roster`
    )
  return id
}

const APPLY: {
  [K in RosterCommandType]: (
    staging: Staging,
    command: Extract<RosterCommand, { type: K }>
  ) => void
} = {
  addPlayer(staging, command) {
    const name = command.name.trim().replace(/\s+/g, ' ')
    const jersey = command.jersey?.trim() ?? ''
    if (name === '') refuse("Say the new player's name")
    if (!/^\d*$/.test(jersey)) refuse('Use digits for the jersey number.')
    if (command.player == null)
      refuse('Create the player before adding him to the game')
    const id = addPlayer(
      staging.state,
      staging.side,
      command.player,
      name,
      jersey
    )
    const [firstName, ...last] = name.split(' ')
    Object.assign(staging.state.gameData.players[id], {
      firstName,
      lastName: last.join(' ')
    })
    staging.lines.push(
      `${nameOf(staging.state, id)}${jersey === '' ? '' : ` #${jersey}`} added to the roster`
    )
  },

  setLineup(staging, command) {
    const order = [...new Set(command.order.map(id => member(staging, id)))]
    if (order.length === 0) refuse('Name the batters in order')
    staging.state.liveData.boxscore.teams[staging.side].battingOrder = order
    staging.lines.push(
      `Lineup: ${order.map(id => nameOf(staging.state, id)).join(', ')}`
    )
  },

  placeInLineup(staging, command) {
    const team = staging.state.liveData.boxscore.teams[staging.side]
    // The last place said for a player is his.
    const places = new Map<number, number | 'end'>()
    for (const { player, slot } of command.places) {
      places.delete(member(staging, player))
      places.set(player, slot)
    }
    // Everyone named leaves his old place first, so "Judge, Soto and Betts
    // as 3, 4 and 5" puts them there whatever places they held; then each
    // takes his place in turn from the top, and a place past the end, or
    // `end`, is the end.
    const order = team.battingOrder.filter(id => !places.has(id))
    const numbered = [...places].filter(
      (place): place is [number, number] => place[1] !== 'end'
    )
    for (const [player, slot] of numbered.sort((a, b) => a[1] - b[1]))
      order.splice(Math.min(slot - 1, order.length), 0, player)
    for (const [player, slot] of places) if (slot === 'end') order.push(player)
    team.battingOrder = order
    for (const player of places.keys())
      staging.lines.push(
        `${nameOf(staging.state, player)} to ${ordinal(order.indexOf(player) + 1)} in the lineup`
      )
  },

  setPositions(staging, command) {
    const defense = staging.state.liveData.boxscore.teams[staging.side].defense
    const displaced = new Set<number>()
    const placed = new Map<number, Position>()
    for (const { player, position } of command.places) {
      member(staging, player)
      for (const held of POSITIONS)
        if (defense[held] === player) defense[held] = null
      const holder = defense[position]
      if (holder != null && holder !== player) displaced.add(holder)
      defense[position] = player
      placed.delete(player)
      placed.set(player, position)
    }
    for (const [player, position] of placed)
      staging.lines.push(`${nameOf(staging.state, player)} to ${position}`)
    // Whoever lost his place keeps his slot in the order.
    for (const player of displaced)
      if (!POSITIONS.some(position => defense[position] === player))
        staging.lines.push(`${nameOf(staging.state, player)} off the field`)
  },

  pinchHitter(staging, command) {
    const { state, side } = staging
    if (!staging.situation.live)
      refuse('Pinch hitters only once the game has begun')
    const player = member(staging, command.player)
    const team = state.liveData.boxscore.teams[side]
    if (team.battingOrder.includes(player))
      refuse(`${nameOf(state, player)} is already in the lineup`)
    const due =
      staging.nextBatter ??
      state.liveData.linescore.offense.batter?.id ??
      team.battingOrder[team.battingIndex]
    const slot = due == null ? -1 : team.battingOrder.indexOf(due)
    if (slot < 0) refuse('Nobody is due up')
    team.battingOrder[slot] = player
    staging.nextBatter = player
    staging.lines.push(
      `${nameOf(state, player)} pinch-hits for ${nameOf(state, due)}`
    )
  },

  pinchRunner(staging, command) {
    const { state, situation } = staging
    if (!situation.live) refuse('Pinch runners only once the game has begun')
    const player = member(staging, command.player)
    const runner = situation.runnersOn[command.base]
    if (runner == null) refuse(`Nobody is on ${command.base}`)
    if (
      Object.values(situation.runnersOn).includes(player) ||
      staging.runners.some(
        staged => staged.player === player && staged.base !== command.base
      )
    )
      refuse(`${nameOf(state, player)} is already on base`)
    const up =
      staging.nextBatter ??
      state.liveData.plays.currentPlay?.matchup.batter.id ??
      state.liveData.linescore.offense.batter?.id
    if (player === up) refuse(`${nameOf(state, player)} is already batting`)
    staging.runners = [
      ...staging.runners.filter(staged => staged.base !== command.base),
      { base: command.base, player }
    ]
    staging.lines.push(
      `${nameOf(state, player)} runs for ${nameOf(state, runner)}`
    )
  }
}

/** What a sentence's said players came to. */
export type RosterResolution =
  | { commands: RosterCommand[] }
  | { question: RosterQuestion }
  | { problem: string }

/**
 * A question for the scorer when a player said fits two or more: one option
 * for each, carrying the sentence with him chosen, and resolved as far as it
 * goes, so choosing it resolves the sentence as if it had been said so.
 */
export interface RosterQuestion {
  question: string
  options: RosterOption[]
}
export interface RosterOption {
  label: string
  /** The team of the player this option chooses. */
  side: Side
  commands: ChosenRosterCommand[]
}

/** Where a sentence lands: the game's situation, and a coach's own side. */
export interface RosterResolving {
  live: boolean
  battingSide: Side
  /** A coach's side, the only one his commands name players from. */
  fixedSide?: Side
}

/** Each of a command's players in turn, mapped by `to`. */
function mapPlayers<P, Q>(
  command: Said<P>,
  to: (player: P, at: number) => Q
): Said<Q> {
  let at = 0
  const each = (player: P): Q => to(player, at++)
  switch (command.type) {
    case 'addPlayer':
      return command
    case 'setLineup':
      return { ...command, order: command.order.map(each) }
    case 'placeInLineup':
      return {
        ...command,
        places: command.places.map(place => ({
          ...place,
          player: each(place.player)
        }))
      }
    case 'pinchHitter':
    case 'pinchRunner':
      return { ...command, player: each(command.player) }
    case 'setPositions':
      return {
        ...command,
        places: command.places.map(place => ({
          ...place,
          player: each(place.player)
        }))
      }
  }
}
function playersOf<P>(command: Said<P>): P[] {
  const players: P[] = []
  mapPlayers(command, player => players.push(player))
  return players
}

/** Text as names are compared: no case, accents or punctuation. */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** The names a player answers to: last, first, full, short and the model's. */
function namesOf(state: GameState, player: GamePlayer): Set<string> {
  const words = player.fullName.trim().split(/\s+/)
  const model = state.meta.modelNames?.[player.id]
  const or = (name: string | undefined, word: string | undefined): string =>
    name == null || name.trim() === '' ? (word ?? '') : name
  return new Set(
    [
      or(player.lastName, words.at(-1)),
      or(player.firstName, words[0]),
      player.fullName,
      shortName(player),
      ...(model == null ? [] : [model, model.split(' ')[0]])
    ]
      .map(fold)
      .filter(name => name !== '')
  )
}

/** The players of `side` a player said can be: his number and his name both fit. */
function matches(
  state: GameState,
  side: Side,
  said: PlayerSaid | number
): number[] {
  const roster = state.liveData.boxscore.teams[side].players.filter(
    id => state.gameData.players[id] != null
  )
  if (typeof said === 'number') return roster.filter(id => id === said)
  const name = said.name == null ? undefined : fold(said.name)
  return roster.filter(id => {
    const player = state.gameData.players[id]
    return (
      (said.jersey == null || player.jersey.trim() === said.jersey) &&
      (name == null || namesOf(state, player).has(name))
    )
  })
}

/** A player as the scorer said him, for a question or a refusal. */
function spoken(state: GameState, said: PlayerSaid | number): string {
  if (typeof said === 'number') {
    const player = state.gameData.players[said]
    return player == null ? `player ${said}` : drawnName(player)
  }
  return [said.name, said.jersey == null ? undefined : `#${said.jersey}`]
    .filter(part => part != null)
    .join(' ')
}

const otherSide = (side: Side): Side => (side === 'away' ? 'home' : 'away')

/** A command about `side`, when it is a command that names its team. */
const onSide = (
  command: ChosenRosterCommand,
  side: Side
): ChosenRosterCommand =>
  command.type === 'pinchHitter' || command.type === 'pinchRunner'
    ? command
    : { ...command, side }

/**
 * Finds the players of a sentence said, by fixed rules, and answers the
 * commands with their ids, a question when a player fits two or more, or why
 * a player fits nobody.
 *
 * 1. The team: a coach's `fixedSide`; else the team the scorer named; else
 *    the team at bat for `pinchHitter` and `pinchRunner`, and, once the
 *    game has begun, the team in the field for `setPositions`; else either
 *    team. Commands left with either team are about one team together: one
 *    that has every one of their players.
 * 2. The player, on that team only: a number fits the player who wears it,
 *    and a name a player's last, first, full or short name, whatever its
 *    case and accents.
 * 3. One fit is the player. None refuses the sentence. Two or more ask which,
 *    about the first player said who fits more than one.
 */
export function resolveRosterCommands(
  state: GameState,
  said: readonly ChosenRosterCommand[],
  situation: RosterResolving
): RosterResolution {
  const { live, battingSide: batting, fixedSide } = situation
  // A pinch hitter or runner is the side at bat's even before the game,
  // when he is refused: there is nobody to ask about.
  const teamOf = (command: ChosenRosterCommand): Side | undefined =>
    fixedSide ??
    ('side' in command ? command.side : undefined) ??
    (command.type === 'pinchHitter' || command.type === 'pinchRunner'
      ? batting
      : live && command.type === 'setPositions'
        ? otherSide(batting)
        : undefined)
  const teams = said.map(teamOf)
  const open = said.filter((_, at) => teams[at] == null).flatMap(playersOf)
  const viable = SIDES.filter(side =>
    open.every(player => matches(state, side, player).length > 0)
  )
  const teamName = (side: Side): string => state.gameData.teams[side].name
  // Every player said, with the players he can be.
  const fits = said.map((command, at) => {
    const sides =
      teams[at] != null ? [teams[at]] : viable.length > 0 ? viable : [...SIDES]
    return playersOf(command).map(player => ({
      player,
      sides,
      found: sides.flatMap(side =>
        matches(state, side, player).map(id => ({ side, id }))
      )
    }))
  })
  for (const { player, sides, found } of fits.flat())
    if (found.length === 0)
      return {
        problem: `No ${spoken(state, player)} on the ${sides.map(teamName).join(' or the ')}`
      }
  if (open.length > 0 && viable.length === 0)
    return { problem: ONE_TEAM_AT_A_TIME }
  // The first player who fits two or more, asked about; each option is the
  // sentence with him chosen, and the commands about either team about his.
  for (const [at, players] of fits.entries())
    for (const [which, { player, found }] of players.entries()) {
      if (found.length < 2) continue
      const both = new Set(found.map(fit => fit.side)).size > 1
      return {
        question: {
          question: `Which ${spoken(state, player)}?`,
          options: found.map(({ side, id }) => {
            const chosen = said.map((command, each) => {
              const sided =
                teams[each] == null ? onSide(command, side) : command
              return each === at
                ? mapPlayers(sided, (was, place) =>
                    place === which ? id : was
                  )
                : sided
            })
            const resolved = resolveRosterCommands(state, chosen, situation)
            const person = state.gameData.players[id]
            return {
              label: `${drawnName(person)}${person.jersey.trim() === '' ? '' : ` #${person.jersey.trim()}`}${both ? `, ${teamName(side)}` : ''}`,
              side,
              commands: 'commands' in resolved ? resolved.commands : chosen
            }
          })
        }
      }
    }
  // Commands about either team that name nobody: which team.
  if (said.some((_, at) => teams[at] == null) && viable.length > 1)
    return {
      question: {
        question: 'Which team?',
        options: viable.map(side => {
          const chosen = said.map((command, at) =>
            teams[at] == null ? onSide(command, side) : command
          )
          return { label: teamName(side), side, commands: chosen }
        })
      }
    }
  return {
    commands: said.map((command, at) => {
      const ids = fits[at].map(fit => fit.found[0].id)
      return asRosterCommand({
        ...mapPlayers(command, (_, place) => ids[place]),
        side: teams[at] ?? viable[0]
      })
    })
  }
}

/**
 * Each side's whole roster, for a model to spell what it heard by: the
 * batting order first, then everyone else, each by name and number with his
 * place in the order and his position, or the bench. It names no ids: the
 * model reports players as said, and `resolveRosterCommands` finds them.
 */
export function rosterPrompt(state: GameState, sides: readonly Side[]): string {
  return sides
    .map(side => {
      const name = state.gameData.teams[side].name
      const team = state.liveData.boxscore.teams[side]
      const everyone = [
        ...team.battingOrder,
        ...team.players.filter(id => !team.battingOrder.includes(id))
      ]
      const lines = everyone
        .filter(id => state.gameData.players[id] != null)
        .map(id => {
          const player = state.gameData.players[id]
          const jersey = player.jersey.trim()
          const slot = team.battingOrder.indexOf(id)
          const position = POSITIONS.find(at => team.defense[at] === id)
          const roles = [
            ...(slot < 0 ? [] : [`bats ${ordinal(slot + 1)}`]),
            ...(position == null ? [] : [`plays ${position}`])
          ]
          return `  ${modelNameOf(state, player)}${jersey === '' ? '' : ` #${jersey}`} — ${roles.length === 0 ? 'bench' : roles.join(', ')}`
        })
      return [`${side.toUpperCase()} — ${name}`, ...lines].join('\n')
    })
    .join('\n')
}

export interface RosterTool {
  name: RosterCommandType
  description: string
  input_schema: JsonSchema
}

const sideField: JsonSchema = {
  type: 'string',
  enum: ['away', 'home'],
  description:
    "The team, only when the scorer's words name it: its name, home or away. Leave it out otherwise, even when you can tell"
}
/** A player as said: never an id, and never a player the scorer did not say. */
const playerField = (description: string): JsonSchema => ({
  type: 'object',
  description: `${description}. Number as said. Name is the ROSTERS spelling when the heard name is one sound off from exactly one listed player, never the misspelling; otherwise the name said`,
  properties: {
    jersey: {
      type: 'string',
      description: 'The number said, in digits: "number 3" is "3"'
    },
    name: {
      type: 'string',
      description:
        'The ROSTERS spelling when the heard name is one sound off from exactly one listed player. Heard "Jarrett" with only Jared Hale listed is "Jared Hale". Never write the misspelling in this field. Otherwise the name said'
    }
  },
  additionalProperties: false
})
function rosterTool(
  name: RosterCommandType,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[]
): RosterTool {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  }
}

/**
 * One tool per roster command, for a dictation model to call. The tool's
 * input is the command as said (`SaidRosterCommand`) without its `type`,
 * which is the tool's name.
 */
export function rosterToolSchema(): RosterTool[] {
  return [
    rosterTool(
      'addPlayer',
      'Creates a real player on the team roster by default. Only set placeholder true when the speaker explicitly says placeholder; that creates a game-only player.',
      {
        side: sideField,
        name: { type: 'string', description: "The player's name" },
        jersey: { type: 'string', description: 'His number, digits only' },
        placeholder: {
          type: 'boolean',
          description:
            'True only when the speaker explicitly says placeholder. Otherwise omit or false: create a real rostered player.'
        }
      },
      ['name']
    ),
    rosterTool(
      'setLineup',
      'Sets a team\'s whole batting order. "Substitute A for B" puts A where B stood and leaves B out of the order; every other batter of A\'s team stays, and the other team is not in the order. Any other wording is the names said, leadoff first. Anyone not named leaves the order and stays on the roster.',
      {
        side: sideField,
        order: {
          type: 'array',
          items: playerField('A batter'),
          description:
            'Leadoff first. On a substitution the replaced player is absent and the new player stands in his place'
        }
      },
      ['order']
    ),
    rosterTool(
      'placeInLineup',
      "Puts players at places in a team's batting order, each in turn, taking him out of his old place first. A place past the end, or end, is the end.",
      {
        side: sideField,
        places: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              player: playerField('The player'),
              slot: {
                anyOf: [
                  { type: 'integer', minimum: 1 },
                  { type: 'string', enum: ['end'] }
                ],
                description: 'His place in the order from 1, or end'
              }
            },
            required: ['player', 'slot']
          }
        }
      },
      ['places']
    ),
    rosterTool(
      'pinchHitter',
      "A pinch hitter for the batter due up, from the side at bat's roster. He takes that batter's place in the order and bats now.",
      {
        player: playerField(
          'The pinch hitter, who comes in: never the batter due up'
        )
      },
      ['player']
    ),
    rosterTool(
      'pinchRunner',
      'A pinch runner for a runner of the side at bat. He takes the base, and the batting order stays as it is.',
      {
        player: playerField(
          'The pinch runner, who comes in: never the runner on the base'
        ),
        base: {
          type: 'string',
          enum: BASES,
          description: 'The base of the runner he runs for'
        }
      },
      ['player', 'base']
    ),
    rosterTool(
      'setPositions',
      'Puts players at fielding positions. Each leaves any position he held; the batting order does not change. The screen knows which team is in the field: give side only when the scorer names the team.',
      {
        side: sideField,
        places: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              player: playerField('The player'),
              position: {
                type: 'string',
                enum: POSITIONS,
                description: 'Where he plays'
              }
            },
            required: ['player', 'position']
          }
        }
      },
      ['places']
    )
  ]
}
