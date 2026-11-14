import { shortName } from '../../common/names'
import {
  type ActionChain,
  actionKey,
  type ChainMix,
  createActionChain
} from '../../common/scoring/actionChain'
import type { ScoringAction } from '../../common/scoring/actions'
import type { AcceptedPicture } from '../../common/scoring/session'
import type { GameState } from '../../common/scoring/state'
import { lstrings, sprintf } from '../locales/strings'
import { actionWords } from './actionWords'
import { shortPlayerNames } from './currentSetup'
import {
  describeLogSpans,
  type LogDescriptionCache,
  type LogSpan,
  newLogDescriptionCache
} from './playDescription'

/**
 * The game as the remote log names it: each player by exactly the label the
 * defensive field draws, and the key of those labels, which changes when a
 * roster change relabels anyone.
 */
export function readableFor(state: GameState): {
  readable: (game: GameState) => GameState
  labelKey: string
} {
  const labels = shortPlayerNames(Object.values(state.gameData.players))
  const readable = (game: GameState): GameState => ({
    ...game,
    gameData: {
      ...game.gameData,
      players: Object.fromEntries(
        Object.entries(game.gameData.players).map(([id, player]) => [
          id,
          {
            ...player,
            fullName:
              labels.get(player.id) ??
              player.compactName ??
              shortName({ ...player, displayName: player.fullName }),
            nameFormat: 'full' as const
          }
        ])
      )
    }
  })
  return { readable, labelKey: JSON.stringify([...labels]) }
}

/** The remote log keeps this many lines, oldest first to go. */
export const REMOTE_LOG_LINES = 50

/** One row of the remote scoring log: one scorer's span, or a removal. */
export interface RemoteLogRow {
  id: string
  userId: string
  name: string
  lines: string[]
}

/**
 * Everything the log carries between notifications. Bounded by what it
 * shows: one key list per at-bat, one seen count per at-bat, one basis per
 * displayed row, and the chain of the last accepted history.
 */
export interface RemoteLogState {
  viewer: string
  chain: ActionChain
  cache: LogDescriptionCache
  labelKey?: string
  /** At-bat → the keys of its actions at the last notification. */
  keys: Map<number, string[]>
  /**
   * The history at mount could not be described: the first notification
   * that can describe its history takes all of it as seen.
   */
  baseline: boolean
  /** At-bat → how many of its leading actions were there when it opened. */
  seen: Map<number, number>
  /** Removal ids present at mount, never shown. */
  mountRemovals: Set<string>
  rows: RemoteLogRow[]
  /** Row id → what it was built from: `length` actions, `chain[length]`. */
  basis: Map<string, { length: number; hash: string }>
  /** Undo row id → its removal's sequence, for each displayed Undo row. */
  sequences: Map<string, number>
}

export interface RemoteLogOptions {
  mix?: ChainMix
  /** Tests only: describe spans with this instead of the shared formatter. */
  describe?: typeof describeLogSpans
}

const spanKeys = (accepted: AcceptedPicture, span: LogSpan): string[] => {
  const keys: string[] = []
  for (let i = span.from; i < span.to; i++)
    keys.push(actionKey(accepted.actions[i], accepted.authors[i]))
  return keys
}

function atBatKeys(
  accepted: AcceptedPicture,
  spans: readonly LogSpan[],
  from = 0
): Map<number, string[]> {
  // Every span of each at-bat reaching `from`: one ending exactly there may
  // have lost its tail.
  const touched = new Set(
    spans.filter(span => span.to >= from).map(span => span.atBatIndex)
  )
  const keys = new Map<number, string[]>()
  for (const span of spans) {
    if (!touched.has(span.atBatIndex)) continue
    const list = keys.get(span.atBatIndex) ?? []
    list.push(...spanKeys(accepted, span))
    keys.set(span.atBatIndex, list)
  }
  return keys
}

/**
 * Words for a span the formatter could not tell, from its actions alone,
 * written as the formatter writes a list: only its first word capitalised.
 */
const fallbackWords = (actions: readonly ScoringAction[]): string =>
  actions
    .filter(action => action.type !== 'gameFlow' || action.kind !== 'closePlay')
    .map((action, index) => {
      const words = actionWords(action)
      return index === 0
        ? words
        : words.charAt(0).toLowerCase() + words.slice(1)
    })
    .join(', ')

const nameOf = (accepted: AcceptedPicture, userId: string): string => {
  const name = accepted.names[userId]
  return name == null || name === '' ? lstrings.remote_log_another_scorer : name
}

/** The log as it opens: everything already accepted counts as seen. */
export function startRemoteLog(
  accepted: AcceptedPicture | undefined,
  viewer: string,
  options: RemoteLogOptions = {}
): RemoteLogState {
  const state: RemoteLogState = {
    viewer,
    chain: createActionChain({ mix: options.mix }),
    cache: newLogDescriptionCache(),
    keys: new Map(),
    baseline: false,
    seen: new Map(),
    mountRemovals: new Set(accepted?.removals.map(removal => removal.id)),
    rows: [],
    basis: new Map(),
    sequences: new Map()
  }
  if (accepted == null) return state
  try {
    // The description cache keys on the authored chain the next notification
    // passes, so the first one resumes instead of replaying the whole game.
    const { chain } = state.chain.extend(accepted.actions, accepted.authors)
    const { spans } = spansOf(state, accepted, options, chain)
    state.keys = atBatKeys(accepted, spans)
    for (const [atBat, list] of state.keys) state.seen.set(atBat, list.length)
  } catch {
    // A display-only log never takes down the screen that mounts it.
    state.chain = createActionChain({ mix: options.mix })
    state.cache = newLogDescriptionCache()
    state.keys = new Map()
    state.seen = new Map()
    state.baseline = true
  }
  return state
}

function spansOf(
  state: RemoteLogState,
  accepted: AcceptedPicture,
  options: RemoteLogOptions,
  chain?: readonly string[],
  fresh = false
): { spans: LogSpan[] } {
  const { readable, labelKey } = readableFor(accepted.state)
  if (fresh) state.cache = newLogDescriptionCache()
  if (state.labelKey !== labelKey) {
    state.cache.spans.clear()
    state.labelKey = labelKey
  }
  const describe = options.describe ?? describeLogSpans
  return {
    spans: describe(
      accepted.opening,
      accepted.actions,
      accepted.authors,
      readable,
      state.cache,
      fresh ? undefined : chain
    )
  }
}

/**
 * What the scorer dismissed stays dismissed: every action and removal the
 * log has seen so far counts as seen, and only later ones become rows.
 */
export function dismissRemoteLog(
  state: RemoteLogState,
  accepted: AcceptedPicture | undefined
): void {
  for (const [atBat, keys] of state.keys) state.seen.set(atBat, keys.length)
  for (const removal of accepted?.removals ?? [])
    state.mountRemovals.add(removal.id)
  state.rows = []
  state.basis = new Map()
  state.sequences = new Map()
}

/**
 * The rows after the accepted history moved. Each is one span of somebody
 * else's actions with an action new since the log opened, or a removal by
 * somebody else since then. Every row is built from `accepted` alone, so
 * whatever the log carried, nothing it shows outlives the history it came
 * from: an inconsistency in what it carried rebuilds every span from scratch.
 */
export function nextRemoteLog(
  state: RemoteLogState,
  accepted: AcceptedPicture | undefined,
  options: RemoteLogOptions = {}
): { state: RemoteLogState; changed: boolean } {
  if (accepted == null) return { state, changed: false }
  try {
    return advance(state, accepted, options)
  } catch {
    // A display-only log never interrupts the session's other listeners.
    // With a fresh chain the next notification compares every at-bat again,
    // against the key lists and seen counts this one left.
    state.chain = createActionChain({ mix: options.mix })
    return { state, changed: false }
  }
}

function advance(
  state: RemoteLogState,
  accepted: AcceptedPicture,
  options: RemoteLogOptions
): { state: RemoteLogState; changed: boolean } {
  let chain: readonly string[]
  let diverge: number
  try {
    ;({ chain, diverge } = state.chain.extend(
      accepted.actions,
      accepted.authors
    ))
  } catch {
    // A chain that cannot be built cannot vouch for anything.
    state.chain = createActionChain({ mix: options.mix })
    ;({ chain, diverge } = { chain: [], diverge: 0 })
  }
  const consistent = [...state.basis.values()].every(
    basis =>
      basis.length > diverge ||
      (basis.length <= accepted.actions.length &&
        chain[basis.length] === basis.hash)
  )
  const labels = state.labelKey
  let spans: LogSpan[]
  try {
    ;({ spans } = spansOf(
      state,
      accepted,
      options,
      chain.length === accepted.actions.length + 1 ? chain : undefined,
      !consistent || chain.length !== accepted.actions.length + 1
    ))
  } catch {
    // Whatever the cache held, describe the confirmed history from scratch;
    // if even that cannot be replayed, show nothing new rather than guess.
    ;({ spans } = spansOf(state, accepted, options, undefined, true))
  }
  // A roster change that relabels anyone rewords every row, as it rewords
  // every span.
  const relabeled = state.labelKey !== labels
  // Only at-bats with actions at or after the divergence can have moved; an
  // earlier correction shifts later at-bats in the log, not within their own.
  const moved = atBatKeys(accepted, spans, diverge)
  for (const [atBat, list] of moved) {
    const before = state.keys.get(atBat) ?? []
    let common = 0
    while (
      common < before.length &&
      common < list.length &&
      before[common] === list[common]
    )
      common++
    const seen = state.seen.get(atBat)
    if (seen != null) state.seen.set(atBat, Math.min(seen, common))
    state.keys.set(atBat, list)
  }
  const present = new Set(spans.map(span => span.atBatIndex))
  for (const atBat of [...state.keys.keys()])
    if (!present.has(atBat)) {
      state.keys.delete(atBat)
      state.seen.delete(atBat)
    }
  // At-bats whose actions all precede the divergence kept their key lists.
  const unknown = new Set(
    spans
      .filter(span => !state.keys.has(span.atBatIndex))
      .map(span => span.atBatIndex)
  )
  for (const span of spans)
    if (unknown.has(span.atBatIndex))
      state.keys.set(span.atBatIndex, [
        ...(state.keys.get(span.atBatIndex) ?? []),
        ...spanKeys(accepted, span)
      ])
  if (state.baseline) {
    state.baseline = false
    for (const [atBat, list] of state.keys) state.seen.set(atBat, list.length)
    for (const removal of accepted.removals) state.mountRemovals.add(removal.id)
  }

  const previous = new Map(state.rows.map(row => [row.id, row]))
  const built: RemoteLogRow[] = []
  const basis = new Map<string, { length: number; hash: string }>()
  const sequences = new Map<string, number>()
  /** Each span row's at-bat and the end of its actions within it. */
  const ends = new Map<string, { atBat: number; end: number }>()
  for (const span of spans) {
    const author = span.author
    if (author == null || author === state.viewer) continue
    const seen = state.seen.get(span.atBatIndex) ?? 0
    if (span.position + (span.to - span.from) <= seen) continue
    const id = `seg:${span.atBatIndex}:${span.position}`
    const known = state.basis.get(id)
    const hash = chain[span.to] ?? ''
    const intact =
      consistent &&
      !relabeled &&
      known?.length === span.to &&
      span.to <= diverge &&
      known.hash === hash &&
      previous.get(id)?.userId === author
    const text = intact
      ? previous.get(id)!.lines.join('\n')
      : (span.text ?? fallbackWords(accepted.actions.slice(span.from, span.to)))
    if (text === '') continue
    built.push({
      id,
      userId: author,
      name: nameOf(accepted, author),
      lines: text.split('\n')
    })
    basis.set(id, { length: span.to, hash })
    ends.set(id, {
      atBat: span.atBatIndex,
      end: span.position + (span.to - span.from)
    })
  }
  for (const removal of accepted.removals) {
    if (state.mountRemovals.has(removal.id)) continue
    if (removal.userId === state.viewer) continue
    // Reopening a closed play removes only its closing, which has no words.
    const words = fallbackWords(removal.actions)
    if (words === '') continue
    built.push({
      id: `undo:${removal.id}`,
      userId: removal.userId,
      name: nameOf(accepted, removal.userId),
      lines: [sprintf(lstrings.remote_log_undo, words)]
    })
    sequences.set(`undo:${removal.id}`, removal.sequence)
  }
  // An Undo row stays once the record cap drops its removal, which is older
  // than every removal still listed; one gone any other way, as a reset
  // takes them all, goes with it.
  const oldest =
    accepted.removals.length === 0
      ? undefined
      : Math.min(...accepted.removals.map(removal => removal.sequence))
  const agedOut = (id: string): boolean => {
    const sequence = state.sequences.get(id)
    return sequence != null && oldest != null && sequence < oldest
  }
  // A row keeps its place; a new one goes after every row already shown.
  const byId = new Map(built.map(row => [row.id, row]))
  const ordered: RemoteLogRow[] = []
  for (const row of state.rows) {
    const next = byId.get(row.id)
    if (next != null) {
      ordered.push(next)
      byId.delete(row.id)
    } else if (agedOut(row.id)) {
      ordered.push(row)
      sequences.set(row.id, state.sequences.get(row.id)!)
    }
  }
  ordered.push(...byId.values())
  let remaining = REMOTE_LOG_LINES
  const rows = ordered
    .reverse()
    .flatMap(row => {
      if (remaining <= 0) return []
      const lines = row.lines.slice(-remaining)
      remaining -= lines.length
      return [{ ...row, lines }]
    })
    .reverse()
  // Nothing is kept for a row no longer shown, and a row the cap trims
  // away counts as seen, as a dismissed one does: it never comes back
  // below rows that came after it.
  const shown = new Set(rows.map(row => row.id))
  for (const row of ordered) {
    if (shown.has(row.id)) continue
    const span = ends.get(row.id)
    if (span != null)
      state.seen.set(
        span.atBat,
        Math.max(state.seen.get(span.atBat) ?? 0, span.end)
      )
    else if (row.id.startsWith('undo:'))
      state.mountRemovals.add(row.id.slice('undo:'.length))
  }
  state.basis = new Map([...basis].filter(([id]) => shown.has(id)))
  state.sequences = new Map([...sequences].filter(([id]) => shown.has(id)))
  const listed = new Set(accepted.removals.map(removal => removal.id))
  for (const id of [...state.mountRemovals])
    if (!listed.has(id)) state.mountRemovals.delete(id)
  const changed = JSON.stringify(rows) !== JSON.stringify(state.rows)
  state.rows = rows
  return { state, changed }
}
