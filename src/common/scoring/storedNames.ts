import {
  type ActionMove,
  type ActionRole,
  type ActionSaid,
  actionSentence,
  type EventSaid
} from './document'
import { upgradeRecord } from './legacyRecord'
import { lineupSaid, saidNames, type SaidPlayer } from './lineup'
import { POSITIONS } from './state'

/**
 * A game document in two forms. The **named** form is what the engine builds
 * and every screen reads: each player reference carries `fullName`, each
 * credit its `label`, each described event its sentence. The **stored** form
 * is what the server keeps: the same document with every name of a person who
 * has an id taken out, so the names can be read from the accounts instead.
 * `withNames(withoutNames(play), namesIn(play))` is the play again for every
 * play the engine builds. A reference with no id keeps its typed name: it is
 * that player's only identity.
 */

/** The name of the player with a gumbo id, or undefined for one unknown. */
export type NameOf = (gumboId: number) => string | undefined

/** Who wrote a play, as `eventWrite.ts` names it. */
export type PlaySource = 'external' | 'manual' | 'teamstation'

type Json = Record<string, unknown>

function object(value: unknown): value is Json {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** The keys a person's name is stored under on a reference or a player. */
const NAME_KEYS = ['fullName', 'firstName', 'lastName'] as const

/** The keys of a play event that name a player. */
const EVENT_REFS = [
  'player',
  'replacedPlayer',
  'pitcher',
  'catcher',
  'fielder',
  'batter',
  'runner',
  'responsiblePitcher'
] as const

/**
 * The references a named document carries `fullName` on. A responsible
 * pitcher is named by `{ id }` alone, so a stored one loses any name it was
 * sent with and is given none back.
 */
const NAMED_REFS = new Set<string>(
  EVENT_REFS.filter(key => key !== 'responsiblePitcher')
)

function nameOfIn(names: NameOf | ReadonlyMap<number, string>): NameOf {
  return typeof names === 'function' ? names : id => names.get(id)
}

/** A reference with an id, without its name; one without an id as it is. */
function unnamedRef(ref: unknown): unknown {
  if (!object(ref) || typeof ref.id !== 'number') return ref
  if (!NAME_KEYS.some(key => key in ref)) return ref
  const { fullName: _f, firstName: _a, lastName: _b, ...out } = ref
  return out
}

/** A reference with an id, named; one without an id as it is. */
function namedRef(ref: unknown, nameOf: NameOf): unknown {
  if (!object(ref) || typeof ref.id !== 'number') return ref
  const name = nameOf(ref.id)
  if (name == null && typeof ref.fullName === 'string') return ref
  return { ...ref, fullName: name ?? '' }
}

/** `value` with `change` made to each of `keys` it holds. */
function changed(
  value: Json,
  keys: Iterable<string>,
  change: (item: unknown, key: string) => unknown
): Json {
  let out: Json | undefined
  for (const key of keys) {
    if (!(key in value)) continue
    const next = change(value[key], key)
    if (next === value[key]) continue
    out ??= { ...value }
    out[key] = next
  }
  return out ?? value
}

function mapped(value: unknown, change: (item: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value
  const out = value.map(change)
  return out.some((item, i) => item !== value[i]) ? out : value
}

// ---- Records ----

/**
 * A `teamStation` record's players, wherever it holds them: its setup before
 * the play and each lineup change's setup. A version 1 record keys them by
 * session id, every later one by gumbo id.
 */
function withPlayers(
  record: Json,
  change: (players: Json) => Json,
  action: (action: Json) => Json = a => a
): Json {
  const setup = (raw: unknown): unknown =>
    object(raw) && object(raw.players)
      ? changed(raw, ['players'], players => change(players as Json))
      : raw
  return changed(record, ['setupBefore', 'actions'], (item, key) =>
    key === 'setupBefore'
      ? setup(item)
      : mapped(item, raw =>
          object(raw) ? action(changed(raw, ['setup'], setup)) : raw
        )
  )
}

function eachPlayer(
  players: Json,
  change: (player: Json, key: string) => Json
): Json {
  let out: Json | undefined
  for (const [key, player] of Object.entries(players)) {
    if (!object(player)) continue
    const next = change(player, key)
    if (next === player) continue
    out ??= { ...players }
    out[key] = next
  }
  return out ?? players
}

function unnamedPlayer(player: Json): Json {
  if (!NAME_KEYS.some(key => key in player)) return player
  const { fullName: _f, firstName: _a, lastName: _b, ...out } = player
  return out
}

function isAddPlayer(action: Json): boolean {
  return action.type === 'lineup' && action.kind === 'addPlayer'
}

/**
 * The drawing detail's references: fielding routes, error credits and runner
 * actions name each player as `{ id, fullName }` under `player` or `runner`.
 */
function detailRefs(raw: unknown, change: (ref: unknown) => unknown): unknown {
  const walk = (value: unknown, parent: string): unknown => {
    if (Array.isArray(value)) return mapped(value, item => walk(item, parent))
    if (!object(value)) return value
    if (
      (parent === 'player' || parent === 'runner') &&
      typeof value.id === 'number'
    )
      return change(value)
    return changed(value, Object.keys(value), (item, key) => walk(item, key))
  }
  return walk(raw, '')
}

/** A version 1 record as version 2 reads it, or undefined when refused. */
function upgraded(record: Json): Json | undefined {
  if (record.version !== 1) return record
  try {
    const next = upgradeRecord(record)
    return object(next) ? next : undefined
  } catch {
    return undefined
  }
}

interface RecordForm {
  record: unknown
  /** A version 1 record `upgradeRecord` refused, kept at version 1. */
  refused: boolean
}

/**
 * A `teamStation` record — a play's, or a game's pregame — in its stored
 * form: a version 1 record upgraded, and every player of every setup without
 * his name, as every `addPlayer` action that names its player by id. A
 * version 1 record `upgradeRecord` refuses is one `cleanRecord` already
 * ignores, so it keeps its version and its players lose their names all the
 * same.
 */
function recordWithoutNames(raw: unknown): RecordForm {
  if (!object(raw)) return { record: raw, refused: false }
  const record = upgraded(raw)
  const refused = record == null
  const unnamed = withPlayers(
    record ?? raw,
    players => eachPlayer(players, unnamedPlayer),
    action =>
      isAddPlayer(action) &&
      'name' in action &&
      (refused || typeof action.player === 'number')
        ? (({ name: _name, ...rest }) => rest)(action)
        : action
  )
  return {
    record: changed(unnamed, ['detail'], detail =>
      detailRefs(detail, unnamedRef)
    ),
    refused
  }
}

/** A stored record named: its players, `addPlayer` actions and detail. */
function recordWithNames(raw: unknown, nameOf: NameOf): unknown {
  if (!object(raw)) return raw
  // A refused version 1 record names players by session id, so nothing in
  // it can be named; nothing reads its names either.
  const record = upgraded(raw)
  if (record == null) return raw
  const named = withPlayers(
    record,
    players =>
      eachPlayer(players, player => {
        const id = typeof player.id === 'number' ? player.id : undefined
        const name = id == null ? undefined : nameOf(id)
        if (name == null && typeof player.fullName === 'string') return player
        return { ...player, fullName: name ?? '' }
      }),
    action => {
      if (!isAddPlayer(action) || typeof action.player !== 'number')
        return action
      const name = nameOf(action.player)
      return name == null || action.name === name ? action : { ...action, name }
    }
  )
  return changed(named, ['detail'], detail =>
    detailRefs(detail, ref => namedRef(ref, nameOf))
  )
}

/**
 * A bare record, as a game's pregame stores one, rather than a play that
 * carries one.
 */
function isRecord(value: Json): boolean {
  return (
    'setupBefore' in value &&
    !('teamStation' in value) &&
    !('about' in value) &&
    typeof value.version === 'number'
  )
}

// ---- Names ----

/** Every id and name a reference, a player or a credit pairs. */
function eachName(
  document: unknown,
  add: (id: number, name: string) => void
): void {
  if (!object(document)) return
  const ref = (value: unknown): void => {
    if (
      object(value) &&
      typeof value.id === 'number' &&
      typeof value.fullName === 'string'
    )
      add(value.id, value.fullName)
  }
  const record = (raw: unknown): void => {
    if (!object(raw) || raw.version === 1) return
    const players = (setup: unknown): void => {
      if (!object(setup) || !object(setup.players)) return
      for (const player of Object.values(setup.players)) ref(player)
    }
    players(raw.setupBefore)
    for (const action of Array.isArray(raw.actions) ? raw.actions : []) {
      if (!object(action)) continue
      players(action.setup)
      if (
        isAddPlayer(action) &&
        typeof action.player === 'number' &&
        typeof action.name === 'string'
      )
        add(action.player, action.name.trim())
    }
    detailRefs(raw.detail, value => {
      ref(value)
      return value
    })
  }
  if (isRecord(document)) {
    record(document)
    return
  }
  const matchup = document.matchup
  if (object(matchup)) {
    ref(matchup.batter)
    ref(matchup.pitcher)
  }
  for (const runner of Array.isArray(document.runners)
    ? document.runners
    : []) {
    if (!object(runner)) continue
    if (object(runner.details)) ref(runner.details.runner)
    for (const credit of Array.isArray(runner.credits) ? runner.credits : [])
      if (object(credit)) ref(credit.player)
  }
  for (const event of Array.isArray(document.playEvents)
    ? document.playEvents
    : [])
    if (object(event)) for (const key of EVENT_REFS) ref(event[key])
  const offense = document.offense
  if (object(offense)) for (const base of BASE_REFS) ref(offense[base])
  for (const credit of Array.isArray(document.credits)
    ? document.credits
    : []) {
    if (!object(credit) || typeof credit.creditUserId !== 'number') continue
    const person = credit.credit
    if (object(person) && typeof person.name === 'string')
      add(credit.creditUserId, person.name)
  }
  record(document.teamStation)
}

const BASE_REFS = ['first', 'second', 'third'] as const

/**
 * The id and name pairs a named document carries — on its references, its
 * credits, its record's setups and its `addPlayer` actions — the first one
 * met for each id.
 */
export function namesIn(document: unknown): Map<number, string> {
  const names = new Map<number, string>()
  eachName(document, (id, name) => {
    if (!names.has(id)) names.set(id, name)
  })
  return names
}

// ---- Credits ----

/** A credit as the stored form keeps it, and the named form shows it. */
export interface StructuredCredit {
  eventType?: string
  teamId?: string | null
  creditUserId: number | null
  head: string
  suffix?: string
  credit?: { role?: string; position?: string | null; name?: string } | null
  assists?: Array<{
    creditUserId: number | null
    position?: string | null
    name?: string
  }>
  assistWord?: 'from' | 'to'
  label?: string
}

/** A credited person's name: by id from the book, or as typed. */
function personName(id: unknown, typed: unknown, nameOf: NameOf): string {
  const name = typeof typed === 'string' ? typed : undefined
  return typeof id === 'number' ? (nameOf(id) ?? name ?? '') : (name ?? '')
}

/**
 * A credit's label, worded from its structure: the head, then, when the
 * credit names somebody, `: <name>` and ` (<position>)` when he has one, the
 * suffix (` pitching`), then the fielders who assisted — ` from A (SS), B
 * (2B)` as the engine words it, or ` to A (1B) to B (2B)` for an outside
 * scorer's chain.
 */
export function creditLabel(credit: StructuredCredit, nameOf: NameOf): string {
  const person = object(credit.credit) ? credit.credit : undefined
  const name = personName(credit.creditUserId, person?.name, nameOf)
  let label = credit.head
  if (credit.creditUserId != null || name !== '') {
    label += `: ${name}`
    if (person?.position != null) label += ` (${person.position})`
  }
  label += credit.suffix ?? ''
  const assists = credit.assists ?? []
  if (assists.length > 0) {
    const word = credit.assistWord ?? 'from'
    label += ` ${word} ${assists
      .map(assist => {
        const who = personName(assist.creditUserId, assist.name, nameOf)
        return assist.position == null ? who : `${who} (${assist.position})`
      })
      .join(word === 'to' ? ' to ' : ', ')}`
  }
  return label
}

/** A structured credit without the names its ids already give. */
function unnamedCredit(credit: Json): Json {
  const { label: _label, ...out } = credit
  const person = out.credit
  if (
    typeof out.creditUserId === 'number' &&
    object(person) &&
    'name' in person
  ) {
    const { name: _name, ...rest } = person
    out.credit = rest
  }
  if (Array.isArray(out.assists))
    out.assists = out.assists.map(assist =>
      object(assist) &&
      typeof assist.creditUserId === 'number' &&
      'name' in assist
        ? (({ name: _name, ...rest }) => rest)(assist)
        : assist
    )
  return out
}

/** Options for reading a credit's label against the play it came with. */
export interface CreditNames {
  /**
   * The id of the player in the play with this name who fielded at this
   * position, or of the one player in it with this name.
   */
  idOf?: (name: string, position: string) => number | undefined
  /** Every name in the play: a suffix that holds one is not kept. */
  names?: Iterable<string>
}

interface Assist {
  name: string
  position: string
}

/** A fielders' chain, `A (SS), B (2B)`, split by `separator`. */
function chainOf(text: string, separator: string): Assist[] | undefined {
  const items: Assist[] = []
  for (const item of text.split(separator)) {
    const match = /^(.+) \(([^()]+)\)$/.exec(item)
    if (match == null) return undefined
    items.push({ name: match[1], position: match[2] })
  }
  return items
}

interface ReadLabel {
  suffix: string
  assists?: Assist[]
  assistWord?: 'from' | 'to'
}

/**
 * The structure of a label after its head: the subject, his position, the
 * suffix and the fielders who assisted, the subject and position matched
 * against the credit's own. Undefined when the rest does not begin with them.
 */
function restOf(
  rest: string,
  name: string,
  position: string | null
): ReadLabel | undefined {
  if (name === '' || !rest.startsWith(name)) return undefined
  let after = rest.slice(name.length)
  if (position != null) {
    const shown = ` (${position})`
    if (!after.startsWith(shown)) return undefined
    after = after.slice(shown.length)
  }
  for (const word of ['to', 'from'] as const) {
    const marker = ` ${word} `
    for (
      let at = after.indexOf(marker);
      at >= 0;
      at = after.indexOf(marker, at + 1)
    ) {
      const assists = chainOf(
        after.slice(at + marker.length),
        word === 'to' ? ' to ' : ', '
      )
      if (assists != null)
        return { suffix: after.slice(0, at), assists, assistWord: word }
    }
  }
  return { suffix: after }
}

/**
 * A credit in its stored form: structured (`head`, `suffix`, `assists`,
 * `assistWord`), with no `label`, and with a name only where the person has
 * no id. A credit the engine structured already loses only its label and
 * names. A credit sent with only a label (an outside scorer's, or one stored
 * before credits had structure) is read from it: the head is the label up to
 * the first `: `, the subject and his position are matched against the
 * credit's own name and position, a fielders' chain after them becomes its
 * assists (each given the id the credit's own `assists` give him at that
 * position, or the one `names.idOf` finds for his name, or kept by name),
 * and the words between that are no name in the play become the suffix. A
 * label the structure cannot word again exactly keeps its head and the
 * credited person only.
 */
export function structuredCredit(
  credit: unknown,
  names: CreditNames = {}
): unknown {
  if (!object(credit)) return credit
  if (typeof credit.head === 'string') return unnamedCredit(credit)
  if (typeof credit.label !== 'string') return credit
  const label = credit.label
  const person = object(credit.credit) ? credit.credit : undefined
  const name = typeof person?.name === 'string' ? person.name : ''
  const position = typeof person?.position === 'string' ? person.position : null
  const split = label.indexOf(': ')
  const head = split < 0 ? label : label.slice(0, split)
  // Whatever structure the sender attached is read again from the label.
  const {
    assists: sentAssists,
    assistWord: _assistWord,
    suffix: _suffix,
    ...rest
  } = credit
  const plain: Json = { ...rest, head }
  const read: ReadLabel | undefined =
    split < 0 ? { suffix: '' } : restOf(label.slice(split + 2), name, position)
  if (read == null) return unnamedCredit(plain)
  const known = [...(names.names ?? []), name].filter(other => other !== '')
  if (read.suffix !== '' && known.some(other => read.suffix.includes(other)))
    return unnamedCredit(plain)
  // Each person is named as the label names him, to check its wording.
  const said = new Map<number, string>()
  if (typeof credit.creditUserId === 'number')
    said.set(credit.creditUserId, name)
  // The fielders the credit itself names by id come first.
  const sent = Array.isArray(sentAssists) ? sentAssists : []
  const sentId = (assist: Assist): number | undefined => {
    for (const one of sent)
      if (
        object(one) &&
        one.name === assist.name &&
        one.position === assist.position &&
        typeof one.creditUserId === 'number'
      )
        return one.creditUserId
    return undefined
  }
  const assists = read.assists?.map(assist => {
    const id = sentId(assist) ?? names.idOf?.(assist.name, assist.position)
    if (id == null)
      return {
        creditUserId: null,
        position: assist.position,
        name: assist.name
      }
    said.set(id, assist.name)
    return { creditUserId: id, position: assist.position }
  })
  const candidate: Json = {
    ...plain,
    ...(read.suffix === '' ? {} : { suffix: read.suffix }),
    ...(assists == null ? {} : { assists, assistWord: read.assistWord })
  }
  return creditLabel(candidate as unknown as StructuredCredit, id =>
    said.get(id)
  ) === label
    ? unnamedCredit(candidate)
    : unnamedCredit(plain)
}

/** A stored credit named: its label, and its person's name by id. */
function namedCredit(credit: unknown, nameOf: NameOf): unknown {
  if (!object(credit) || typeof credit.head !== 'string') return credit
  const structured = credit as unknown as StructuredCredit
  const out: Json = { ...credit, label: creditLabel(structured, nameOf) }
  const person = credit.credit
  if (typeof credit.creditUserId === 'number' && object(person))
    out.credit = {
      ...person,
      name: personName(credit.creditUserId, person.name, nameOf)
    }
  return out
}

// ---- Sentences ----

/** A player a play names, as a sentence's `said` names him. */
function saidPlayerOf(ref: unknown): SaidPlayer {
  if (object(ref) && typeof ref.id === 'number') return ref.id
  return {
    name: object(ref) && typeof ref.fullName === 'string' ? ref.fullName : ''
  }
}

const BASE_NUMBERS: Record<string, number> = {
  '1B': 1,
  '2B': 2,
  '3B': 3,
  '4B': 4,
  score: 4
}

/**
 * The runners an action moved, as the stored play holds them: its runners
 * whose entry names the event, with their stored movement read back to
 * numbered bases.
 */
function movesOf(play: Json, index: unknown): ActionMove[] {
  const runners = Array.isArray(play.runners) ? play.runners : []
  const moves: ActionMove[] = []
  for (const runner of runners) {
    if (!object(runner) || !object(runner.details)) continue
    if (runner.details.playIndex !== index) continue
    const movement = object(runner.movement) ? runner.movement : {}
    const base = (value: unknown): number =>
      typeof value === 'string' ? (BASE_NUMBERS[value] ?? 0) : 0
    const isOut = movement.isOut === true
    moves.push({
      player: saidPlayerOf(runner.details.runner),
      start: base(movement.start),
      end: isOut ? base(movement.outBase) : base(movement.end),
      isOut,
      scored: runner.details.isScoringEvent === true
    })
  }
  return moves
}

const ACTION_ROLES: ReadonlySet<string> = new Set([
  'pitcher',
  'catcher',
  'batter',
  'runner'
])
const LINEUP_KINDS: ReadonlySet<string> = new Set([
  'pitching',
  'defensive',
  'pinch',
  'switch',
  'order',
  'courtesy'
])

function isSaidPlayer(value: unknown): value is SaidPlayer {
  return (
    typeof value === 'number' ||
    (object(value) && typeof value.name === 'string')
  )
}

/** A stored `said`, checked as far as its sentence reads it. */
function saidOfEvent(event: Json): EventSaid | undefined {
  const said = event.said
  if (!object(said) || typeof said.kind !== 'string') return undefined
  if (said.kind === 'action') {
    if (typeof said.eventType !== 'string') return undefined
    const lead = said.lead
    if (
      lead != null &&
      (!object(lead) ||
        !isSaidPlayer(lead.player) ||
        typeof lead.role !== 'string' ||
        !ACTION_ROLES.has(lead.role))
    )
      return undefined
    return said as unknown as ActionSaid
  }
  if (!LINEUP_KINDS.has(said.kind)) return undefined
  if (said.kind === 'order')
    return Array.isArray(said.moved) &&
      said.moved.every(
        item =>
          object(item) &&
          isSaidPlayer(item.player) &&
          typeof item.bats === 'number'
      )
      ? (said as unknown as EventSaid)
      : undefined
  return isSaidPlayer(said.player) ? (said as unknown as EventSaid) : undefined
}

/**
 * An event's sentence, worded from its `said` with `nameOf`'s names, by the
 * same functions that word it in the engine. An action's runners are read
 * from the play. Undefined for an event with no `said`.
 */
export function eventSaid(
  play: unknown,
  event: unknown,
  names: NameOf | ReadonlyMap<number, string>
): string | undefined {
  if (!object(event)) return undefined
  const said = saidOfEvent(event)
  if (said == null) return undefined
  const name = saidNames(nameOfIn(names))
  return said.kind === 'action'
    ? actionSentence(
        name,
        said.eventType,
        said.lead,
        movesOf(object(play) ? play : {}, event.index)
      )
    : lineupSaid(said, name)
}

/** What each position is called in a sentence, as `lineup.ts` words it. */
const PLACES: Record<string, string> = {
  pitcher: 'P',
  catcher: 'C',
  'first base': '1B',
  'second base': '2B',
  shortstop: 'SS',
  'third base': '3B',
  'left field': 'LF',
  'center field': 'CF',
  'right field': 'RF'
}
const FIELDERS: Record<string, string> = {
  pitcher: 'P',
  catcher: 'C',
  'first baseman': '1B',
  'second baseman': '2B',
  shortstop: 'SS',
  'third baseman': '3B',
  'left fielder': 'LF',
  'center fielder': 'CF',
  'right fielder': 'RF'
}

/** Each way `text` splits in two around `separator`. */
function splits(text: string, separator: string): Array<[string, string]> {
  const found: Array<[string, string]> = []
  for (
    let at = text.indexOf(separator);
    at >= 0;
    at = text.indexOf(separator, at + 1)
  )
    found.push([text.slice(0, at), text.slice(at + separator.length)])
  return found
}

/** `text` without `prefix` and `suffix`, or undefined without them. */
function between(
  text: string,
  prefix: string,
  suffix: string
): string | undefined {
  return text.startsWith(prefix) &&
    text.endsWith(suffix) &&
    text.length >= prefix.length + suffix.length
    ? text.slice(prefix.length, text.length - suffix.length)
    : undefined
}

/** The setup players and references of a play: each name, and its ids. */
interface PlayBook {
  nameOf: NameOf
  /** The ids a name is the name of, those the event names first. */
  idsOf: (name: string) => number[]
  ids: number[]
  names: string[]
}

function bookOf(play: Json, event: Json): PlayBook {
  const names = namesIn(play)
  // The event's own, when it is read apart from the play it came in.
  for (const [id, name] of namesIn({ playEvents: [event] }))
    if (!names.has(id)) names.set(id, name)
  const byName = new Map<string, number[]>()
  for (const [id, name] of names) {
    const ids = byName.get(name) ?? []
    ids.push(id)
    byName.set(name, ids)
  }
  const first = new Set(
    EVENT_REFS.map(key => event[key])
      .filter(object)
      .map(ref => ref.id)
  )
  const ranked = (ids: number[]): number[] => [
    ...ids.filter(id => first.has(id)),
    ...ids.filter(id => !first.has(id))
  ]
  return {
    nameOf: id => names.get(id),
    idsOf: name => ranked(byName.get(name) ?? []),
    ids: ranked([...names.keys()]),
    names: [...names.values()].sort((a, b) => b.length - a.length)
  }
}

/** Each pairing of the players two names can be. */
function pairs(book: PlayBook, a: string, b: string): Array<[number, number]> {
  return book
    .idsOf(a)
    .flatMap(x => book.idsOf(b).map((y): [number, number] => [x, y]))
}

/** Each batting order a sentence's list can be, longest names first. */
function orders(
  book: PlayBook,
  text: string
): Array<Array<{ player: number; bats: number }>> {
  const found: Array<Array<{ player: number; bats: number }>> = []
  const walk = (
    at: number,
    so: Array<{ player: number; bats: number }>
  ): void => {
    if (found.length > 0) return
    for (const name of book.names) {
      if (!text.startsWith(`${name} bats `, at)) continue
      const rest = text.slice(at + name.length + 6)
      const match = /^(\d+)(?:st|nd|rd|th)(, |$)/.exec(rest)
      if (match == null) continue
      const next = at + name.length + 6 + match[1].length + 2 + match[2].length
      for (const id of book.idsOf(name)) {
        const item = { player: id, bats: Number(match[1]) }
        if (match[2] === '') found.push([...so, item])
        else walk(next, [...so, item])
      }
    }
  }
  walk(0, [])
  return found
}

/**
 * The `said` each kind of sentence that fits the event's type could have
 * been worded from, read from its description: the names in it mapped back
 * to the ids of the play's players.
 */
function candidatesOf(
  play: Json,
  event: Json,
  eventType: string,
  description: string,
  book: PlayBook
): EventSaid[] {
  const out: EventSaid[] = []
  switch (eventType) {
    case 'pitching_substitution': {
      const one = between(
        description,
        'Pitching Change: ',
        ' comes in to pitch.'
      )
      if (one != null)
        for (const id of book.idsOf(one))
          out.push({ kind: 'pitching', player: id })
      const two = between(description, 'Pitching Change: ', '.')
      if (two != null)
        for (const [a, b] of splits(two, ' replaces '))
          for (const [x, y] of pairs(book, a, b))
            out.push({ kind: 'pitching', player: x, replaced: y })
      return out
    }
    case 'defensive_substitution': {
      for (const [place, position] of Object.entries(PLACES)) {
        const one = between(
          description,
          'Defensive Substitution: ',
          ` comes in, playing ${place}.`
        )
        if (one != null)
          for (const id of book.idsOf(one))
            out.push({
              kind: 'defensive',
              player: id,
              position: position as never
            })
        const two = between(
          description,
          'Defensive Substitution: ',
          `, playing ${place}.`
        )
        if (two == null) continue
        for (const [a, b] of splits(two, ' replaces ')) {
          const pinches: Array<['PH' | 'PR' | undefined, string]> = [
            [undefined, b]
          ]
          if (b.startsWith('pinch-hitter '))
            pinches.push(['PH', b.slice('pinch-hitter '.length)])
          if (b.startsWith('pinch-runner '))
            pinches.push(['PR', b.slice('pinch-runner '.length)])
          for (const [pinch, replaced] of pinches)
            for (const [x, y] of pairs(book, a, replaced))
              out.push({
                kind: 'defensive',
                player: x,
                replaced: y,
                position: position as never,
                ...(pinch == null ? {} : { pinch })
              })
        }
      }
      return out
    }
    case 'offensive_substitution': {
      for (const running of [false, true]) {
        const role = running ? 'Pinch-runner' : 'Pinch-hitter'
        const one = between(
          description,
          `Offensive Substitution: ${role} `,
          ' comes in.'
        )
        if (one != null)
          for (const id of book.idsOf(one))
            out.push({ kind: 'pinch', player: id, running })
        const two = between(
          description,
          `Offensive Substitution: ${role} `,
          '.'
        )
        if (two != null)
          for (const [a, b] of splits(two, ' replaces '))
            for (const [x, y] of pairs(book, a, b))
              out.push({ kind: 'pinch', player: x, replaced: y, running })
      }
      return out
    }
    case 'defensive_switch': {
      for (const [fielder, position] of Object.entries(FIELDERS)) {
        const name = between(
          description,
          '',
          ` remains in the game as the ${fielder}.`
        )
        if (name != null)
          for (const id of book.idsOf(name))
            out.push({
              kind: 'switch',
              player: id,
              position: position as never
            })
      }
      for (const [from, fromPosition] of Object.entries(PLACES))
        for (const [to, position] of Object.entries(PLACES)) {
          const name = between(
            description,
            `Defensive switch from ${from} to ${to} for `,
            '.'
          )
          if (name != null)
            for (const id of book.idsOf(name))
              out.push({
                kind: 'switch',
                player: id,
                position: position as never,
                fromPosition: fromPosition as never
              })
        }
      return out
    }
    case 'ts_batting_order': {
      const list = between(description, 'Batting order change: ', '.')
      if (list != null)
        for (const moved of orders(book, list))
          out.push({ kind: 'order', moved })
      return out
    }
    case 'ts_courtesy_runner': {
      const text = between(
        description,
        'Pinch-runner ',
        '; the batting order is unchanged'
      )
      if (text != null)
        for (const [a, b] of splits(text, ' runs for '))
          for (const [x, y] of pairs(book, a, b))
            out.push({ kind: 'courtesy', player: x, replaced: y })
      return out
    }
  }
  return actionCandidates(play, event, eventType, book)
}

/** The engine's actions whose sentence names the pitcher, and the batter. */
const PITCHER_ACTIONS: ReadonlySet<string> = new Set(['balk', 'wild_pitch'])
const BATTER_ACTIONS: ReadonlySet<string> = new Set([
  'intent_walk',
  'catcher_interf',
  'ts_manual_placement',
  'ts_batter_out'
])

/** Who an action of this type could name first, and as what. */
function actionCandidates(
  play: Json,
  event: Json,
  eventType: string,
  book: PlayBook
): EventSaid[] {
  const action = (lead?: {
    player: SaidPlayer
    role: ActionRole
  }): EventSaid => ({
    kind: 'action',
    eventType,
    ...(lead == null ? {} : { lead })
  })
  const anyone = (role: ActionRole): EventSaid[] =>
    book.ids.map(id => action({ player: id, role }))
  if (PITCHER_ACTIONS.has(eventType)) return anyone('pitcher')
  if (eventType === 'passed_ball') return [action(), ...anyone('catcher')]
  if (BATTER_ACTIONS.has(eventType)) {
    const matchup = object(play.matchup) ? play.matchup : {}
    return [
      action({ player: saidPlayerOf(matchup.batter), role: 'batter' }),
      ...anyone('batter')
    ]
  }
  const runner = movesOf(play, event.index).at(0)
  return runner == null
    ? [action()]
    : [action({ player: runner.player, role: 'runner' }), action()]
}

/**
 * The `said` an event's own fields give — its player, the man it replaced
 * and its position — for a sentence no reading of its description words
 * again. Its sentence will read in the current wording.
 */
function ownSaid(play: Json, event: Json, eventType: string): EventSaid {
  const player = saidPlayerOf(event.player)
  const replaced =
    event.replacedPlayer == null
      ? undefined
      : saidPlayerOf(event.replacedPlayer)
  const position =
    object(event.position) && typeof event.position.abbreviation === 'string'
      ? event.position.abbreviation
      : ''
  const field = (POSITIONS as readonly string[]).includes(position)
    ? (position as never)
    : ('P' as never)
  switch (eventType) {
    case 'pitching_substitution':
      return {
        kind: 'pitching',
        player,
        ...(replaced == null ? {} : { replaced })
      }
    case 'defensive_substitution':
      return {
        kind: 'defensive',
        player,
        ...(replaced == null ? {} : { replaced }),
        position: field
      }
    case 'offensive_substitution':
      return {
        kind: 'pinch',
        player,
        ...(replaced == null ? {} : { replaced }),
        running: position === 'PR'
      }
    case 'defensive_switch':
      return { kind: 'switch', player, position: field }
    case 'ts_batting_order': {
      const slot = Math.floor(Number(event.battingOrder) / 100)
      return {
        kind: 'order',
        moved: [{ player, bats: Number.isFinite(slot) && slot > 0 ? slot : 1 }]
      }
    }
    case 'ts_courtesy_runner':
      return { kind: 'courtesy', player, replaced: replaced ?? player }
  }
  const matchup = object(play.matchup) ? play.matchup : {}
  const runner = movesOf(play, event.index).at(0)
  const lead: ActionSaid['lead'] = PITCHER_ACTIONS.has(eventType)
    ? { player: saidPlayerOf(event.pitcher ?? event.player), role: 'pitcher' }
    : eventType === 'passed_ball'
      ? event.catcher == null
        ? undefined
        : { player: saidPlayerOf(event.catcher), role: 'catcher' }
      : BATTER_ACTIONS.has(eventType)
        ? { player: saidPlayerOf(matchup.batter), role: 'batter' }
        : runner == null
          ? undefined
          : { player: runner.player, role: 'runner' }
  return { kind: 'action', eventType, ...(lead == null ? {} : { lead }) }
}

/** What reading a sentence back to its `said` came to. */
export interface SaidFromDescription {
  said: EventSaid
  /** The `said` words the description again exactly. */
  reproduced: boolean
}

/**
 * The `said` an event that carries only its sentence was worded from: a
 * play stored, or posted by an app, from before sentences carried one. Each
 * kind of sentence that fits the event's type is read against its wording,
 * the names in it mapped back to the ids of the play's players, and one is
 * kept only when `eventSaid` with the play's own names words the description
 * again exactly. When none does, the event's own fields give one, and the
 * sentence will read in the current wording. Undefined for an event with no
 * sentence, and for one whose sentence names none of the play's players and
 * that no reading words again: it names nobody, and stays as it is.
 */
export function saidFromDescription(
  play: unknown,
  event: unknown
): SaidFromDescription | undefined {
  if (!object(play) || !object(event) || !object(event.details))
    return undefined
  const description = event.details.description
  if (typeof description !== 'string' || description === '') return undefined
  const type = event.details.eventType ?? event.details.code
  const eventType = typeof type === 'string' ? type : ''
  const book = bookOf(play, event)
  for (const said of candidatesOf(play, event, eventType, description, book))
    if (eventSaid(play, { ...event, said }, book.nameOf) === description)
      return { said, reproduced: true }
  if (!book.names.some(name => name !== '' && description.includes(name)))
    return undefined
  return { said: ownSaid(play, event, eventType), reproduced: false }
}

// ---- Documents ----

/** A described event's sentence is read from its `said`. */
function describedEvent(event: unknown): event is Json {
  return (
    object(event) &&
    event.isPitch !== true &&
    event.type !== 'pitch' &&
    object(event.details)
  )
}

/** A play event with every reference that has an id unnamed. */
function unnamedEvent(event: unknown, dropDescription: boolean): unknown {
  if (!object(event)) return event
  let out = changed(event, EVENT_REFS, unnamedRef)
  if (
    dropDescription &&
    saidOfEvent(out) != null &&
    object(out.details) &&
    'description' in out.details
  ) {
    const { description: _description, ...details } = out.details
    out = { ...out, details }
  }
  return out
}

/**
 * Each fielder the play's runners credit, by his name and the position he
 * fielded at: what tells two players of one name apart in a label.
 */
function fieldersOf(play: Json): Map<string, number> {
  const found = new Map<string, number>()
  for (const runner of Array.isArray(play.runners) ? play.runners : []) {
    if (!object(runner) || !Array.isArray(runner.credits)) continue
    for (const credit of runner.credits) {
      if (!object(credit) || !object(credit.player)) continue
      const { id, fullName } = credit.player
      const position = object(credit.position)
        ? credit.position.abbreviation
        : undefined
      if (
        typeof id === 'number' &&
        typeof fullName === 'string' &&
        typeof position === 'string'
      )
        found.set(`${fullName}\u0000${position}`, id)
    }
  }
  return found
}

/**
 * What a play's credits are read against: the id of each name in it (a
 * fielder by his name and position first), and every name it holds.
 */
function creditNamesOf(play: Json): CreditNames {
  const names = namesIn(play)
  const ids = new Map<string, number | null>()
  for (const [id, name] of names)
    ids.set(name, ids.has(name) && ids.get(name) !== id ? null : id)
  const fielders = fieldersOf(play)
  return {
    idOf: (name, position) =>
      fielders.get(`${name}\u0000${position}`) ?? ids.get(name) ?? undefined,
    names: [...names.values()]
  }
}

/**
 * A play with each credit given its structure (`structuredCredit`, read
 * against the play's own names), its `label` and its person's name kept
 * beside it.
 */
export function withStructuredCredits<T>(play: T): T {
  if (!object(play) || !Array.isArray(play.credits)) return play
  const names = creditNamesOf(play)
  return {
    ...play,
    credits: play.credits.map(credit => {
      const structured = structuredCredit(credit, names)
      if (!object(credit) || !object(structured)) return structured
      return {
        ...structured,
        ...('label' in credit ? { label: credit.label } : {}),
        ...('credit' in credit ? { credit: credit.credit } : {})
      }
    })
  }
}

/** The stored form of a document, and what making it found. */
export interface StoredForm<T = unknown> {
  document: T
  /**
   * Sentences given a `said` from the event's own fields because no reading
   * of the description worded it again: they will read in the current
   * wording.
   */
  unreproduced: number
  /** A version 1 record `upgradeRecord` refused, kept at version 1. */
  refused: number
}

/**
 * `withoutNames`, counting the sentences it could not read back and the
 * version 1 records it could not upgrade, as a migration reports them.
 */
export function storedForm<T>(
  document: T,
  options: { source?: PlaySource } = {}
): StoredForm<T> {
  if (!object(document)) return { document, unreproduced: 0, refused: 0 }
  if (isRecord(document)) {
    const { record, refused } = recordWithoutNames(document)
    return { document: record as T, unreproduced: 0, refused: refused ? 1 : 0 }
  }
  let play: Json = document
  // The record first, so the names in its sentences map to gumbo ids.
  const record = object(play.teamStation) ? upgraded(play.teamStation) : null
  if (record != null && record !== play.teamStation)
    play = { ...play, teamStation: record }
  const source =
    options.source ?? (object(play.teamStation) ? 'teamstation' : 'manual')
  let unreproduced = 0
  if (source === 'teamstation' && Array.isArray(play.playEvents)) {
    const read = play
    play = changed(play, ['playEvents'], events =>
      mapped(events, event => {
        if (!describedEvent(event) || 'said' in event) return event
        const found = saidFromDescription(read, event)
        if (found == null) return event
        if (!found.reproduced) unreproduced++
        return { ...event, said: found.said }
      })
    )
  }
  const credits = creditNamesOf(play)
  const stripped = recordWithoutNames(play.teamStation)
  const out = changed(
    play,
    ['matchup', 'runners', 'playEvents', 'offense', 'credits', 'teamStation'],
    (value, key) => {
      switch (key) {
        case 'matchup':
          return object(value)
            ? changed(value, ['batter', 'pitcher'], unnamedRef)
            : value
        case 'runners':
          return mapped(value, runner =>
            object(runner)
              ? changed(runner, ['details', 'credits'], (part, at) =>
                  at === 'details'
                    ? object(part)
                      ? changed(
                          part,
                          ['runner', 'responsiblePitcher'],
                          unnamedRef
                        )
                      : part
                    : mapped(part, credit =>
                        object(credit)
                          ? changed(credit, ['player'], unnamedRef)
                          : credit
                      )
                )
              : runner
          )
        case 'playEvents':
          return mapped(value, event =>
            unnamedEvent(event, source !== 'manual')
          )
        case 'offense':
          return object(value) ? changed(value, BASE_REFS, unnamedRef) : value
        case 'credits':
          return mapped(value, credit => structuredCredit(credit, credits))
        default:
          return stripped.record
      }
    }
  )
  return {
    document: out as T,
    unreproduced,
    refused: stripped.refused ? 1 : 0
  }
}

/**
 * A game document's stored form: a play, a current play, or a pregame
 * record. In order: a version 1 record is upgraded (`upgradeRecord`); each
 * described event of a `teamstation` play that has no `said` is given one
 * (`saidFromDescription`); then every name of a person with an id is taken
 * out — from each reference, every setup player and every `addPlayer`
 * action — each credit is structured (`structuredCredit`), and an event that
 * carries `said` loses its description. A reference with no id keeps its
 * name, and a `manual` play keeps its descriptions, a person's own words.
 * Pitch, pitch type, hand and result descriptions name nobody and stay.
 */
export function withoutNames<T>(
  document: T,
  options: { source?: PlaySource } = {}
): T {
  return storedForm(document, options).document
}

/**
 * A game document's named form, the exact inverse of `withoutNames` for every
 * document the engine builds: every reference by id given its `fullName`,
 * every setup player his, an `addPlayer` action its `name`, each structured
 * credit its `label` and its person's name (`creditLabel`), and each event
 * that carries `said` its sentence (`eventSaid`). A version 1 record is
 * upgraded first, so every name is looked up by gumbo id.
 */
export function withNames<T>(
  document: T,
  names: NameOf | ReadonlyMap<number, string>
): T {
  const nameOf = nameOfIn(names)
  if (!object(document)) return document
  if (isRecord(document)) return recordWithNames(document, nameOf) as T
  const named = (ref: unknown): unknown => namedRef(ref, nameOf)
  const play = changed(
    document,
    ['matchup', 'runners', 'offense', 'credits', 'teamStation'],
    (value, key) => {
      switch (key) {
        case 'matchup':
          return object(value)
            ? changed(value, ['batter', 'pitcher'], named)
            : value
        case 'runners':
          return mapped(value, runner =>
            object(runner)
              ? changed(runner, ['details', 'credits'], (part, at) =>
                  at === 'details'
                    ? object(part)
                      ? changed(part, ['runner'], named)
                      : part
                    : mapped(part, credit =>
                        object(credit)
                          ? changed(credit, ['player'], named)
                          : credit
                      )
                )
              : runner
          )
        case 'offense':
          return object(value) ? changed(value, BASE_REFS, named) : value
        case 'credits':
          return mapped(value, credit => namedCredit(credit, nameOf))
        default:
          return recordWithNames(value, nameOf)
      }
    }
  )
  // Sentences last: an action's names its runners as the play names them.
  return changed(play, ['playEvents'], events =>
    mapped(events, event => {
      if (!object(event)) return event
      const out = changed(event, NAMED_REFS, named)
      const sentence = eventSaid(play, out, nameOf)
      if (sentence == null || !object(out.details)) return out
      if (out.details.description === sentence) return out
      const { description: _description, ...details } = out.details
      return { ...out, details: { description: sentence, ...details } }
    })
  ) as T
}
