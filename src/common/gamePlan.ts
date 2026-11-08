import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asString,
  type Cleaner
} from 'cleaners'

import type { LineupPlayer } from './api'
import {
  type GamePlayer,
  type GameSide,
  isPosition,
  type Position,
  POSITIONS
} from './scoring/state'
import { asGumboId } from './userId'

/**
 * A coach's per-inning game plan: one row per batter, in batting order, and
 * one cell per inning naming where that batter plays it. A field position
 * fields; DH and EH bat without fielding; `-` sits; a blank is not yet
 * planned.
 */
export const PLAN_CELLS = [
  'P',
  'C',
  '1B',
  '2B',
  '3B',
  'SS',
  'LF',
  'CF',
  'RF',
  'DH',
  'EH',
  '-'
] as const
/** `''` is an inning not yet planned. */
export type PlanCell = (typeof PLAN_CELLS)[number] | ''
export const DEFAULT_PLAN_INNINGS = 6
export const MAX_PLAN_INNINGS = 12

export interface GamePlanRow {
  player: LineupPlayer
  /** One per inning: `cells.length === innings`. */
  cells: PlanCell[]
}

export interface GamePlan {
  /** Whether the scorekeeper's game moves the defence at each inning's end. */
  enabled: boolean
  innings: number
  rows: GamePlanRow[]
}

export const OUTFIELD_POSITIONS = ['LF', 'CF', 'RF'] as const

const isPlanCell = (raw: string): raw is PlanCell =>
  raw === '' || PLAN_CELLS.includes(raw as (typeof PLAN_CELLS)[number])

/**
 * What a cell's text means: a value of `PLAN_CELLS` in any case, or `''`,
 * once trimmed. Anything else is null, which the plan never takes. A cell
 * holds two characters, so longer text (a paste of `SSS`, or of `LF ` with
 * its space) is null before it is trimmed.
 */
export function planCellOf(text: string): PlanCell | null {
  if (text.length > 2) return null
  const cell = text.trim().toUpperCase()
  return isPlanCell(cell) ? cell : null
}

const asPlanCell: Cleaner<PlanCell> = raw => {
  if (typeof raw === 'string' && isPlanCell(raw)) return raw
  throw new TypeError(
    `Expected a plan cell (${PLAN_CELLS.join(', ')} or blank), got ${JSON.stringify(raw)}`
  )
}

const asPlanShape = asObject({
  enabled: asBoolean,
  innings: asNumber,
  rows: asArray(
    asObject({
      player: asObject({
        gumboId: asEither(asNull, asGumboId),
        fullName: asString,
        jersey: asString
      }),
      cells: asArray(asPlanCell)
    })
  )
})

/**
 * Cleans a plan as it is saved and stored: whole innings from 1 to
 * `MAX_PLAN_INNINGS`, and in every row exactly one cell per inning, each a
 * value of `PLAN_CELLS` as it is stored (upper case, untrimmed) or blank.
 * Anything else is a `TypeError`, which the server answers with 400.
 */
export const asGamePlan: Cleaner<GamePlan> = raw => {
  const plan = asPlanShape(raw)
  if (
    !Number.isInteger(plan.innings) ||
    plan.innings < 1 ||
    plan.innings > MAX_PLAN_INNINGS
  )
    throw new TypeError(
      `Expected 1 to ${MAX_PLAN_INNINGS} innings, got ${plan.innings}`
    )
  plan.rows.forEach((row, at) => {
    if (row.cells.length !== plan.innings)
      throw new TypeError(
        `Row ${at + 1} has ${row.cells.length} cells for ${plan.innings} innings`
      )
  })
  return plan
}

/** The first letters a two-letter value starts with that are no value. */
const PLAN_PREFIXES: ReadonlySet<string> = new Set(
  PLAN_CELLS.filter(cell => cell.length === 2)
    .map(cell => cell[0])
    .filter(letter => planCellOf(letter) == null)
)

export type PlanCellEntry =
  { commit: PlanCell } | { pending: string } | { refuse: true }

function entryOf(text: string): PlanCellEntry {
  const cell = planCellOf(text)
  if (cell != null) return { commit: cell }
  const typed = text.trim().toUpperCase()
  if (text.length <= 2 && PLAN_PREFIXES.has(typed)) return { pending: typed }
  return { refuse: true }
}

/**
 * A key typed into a web cell, checked against the values as it arrives.
 * `previous` is what the input showed before it and `text` what it shows
 * now. A whole value commits; `S`, `1`, `2`, `3`, `L`, `R`, `D` and `E`,
 * which only start one, are held pending while the cell keeps its stored
 * value; anything else is refused. P, C and `-` commit at once, so a key
 * typed after one is read with it (C then F is CF) and, when the two make
 * nothing, on its own (P then S is a pending S).
 */
export function planCellEntry(previous: string, text: string): PlanCellEntry {
  const entry = entryOf(text)
  if (!('refuse' in entry)) return entry
  const shown = previous.trim().toUpperCase()
  const typed = text.trim().toUpperCase()
  if (
    text.length <= 2 &&
    shown !== '' &&
    planCellOf(shown) != null &&
    typed.startsWith(shown)
  )
    return entryOf(typed.slice(shown.length))
  return entry
}

const fitted = (cells: readonly PlanCell[], innings: number): PlanCell[] =>
  Array.from({ length: innings }, (_, inning) => cells[inning] ?? '')

/**
 * Which stored row each batter keeps, in batting order: the row of his
 * `gumboId`, else the row of his name and jersey. A row goes to one batter.
 */
function matchedRows(
  rows: readonly GamePlanRow[],
  lineup: readonly LineupPlayer[]
): Array<GamePlanRow | undefined> {
  const taken = new Set<GamePlanRow>()
  const matched = lineup.map(player => {
    if (player.gumboId == null) return undefined
    const row = rows.find(
      candidate =>
        !taken.has(candidate) && candidate.player.gumboId === player.gumboId
    )
    if (row != null) taken.add(row)
    return row
  })
  return lineup.map((player, at) => {
    if (matched[at] != null) return matched[at]
    const row = rows.find(
      candidate =>
        !taken.has(candidate) &&
        candidate.player.fullName === player.fullName &&
        candidate.player.jersey === player.jersey
    )
    if (row != null) taken.add(row)
    return row
  })
}

/**
 * The plan for the lineup as it stands: one row per batter in its batting
 * order, each with his stored cells (blank when he has none), padded or cut
 * to the plan's innings. A stored row nobody bats in is dropped.
 */
export function alignPlan(
  plan: GamePlan,
  lineup: readonly LineupPlayer[]
): GamePlan {
  const rows = matchedRows(plan.rows, lineup)
  return {
    enabled: plan.enabled,
    innings: plan.innings,
    rows: lineup.map((player, at) => ({
      player,
      cells: fitted(rows[at]?.cells ?? [], plan.innings)
    }))
  }
}

/** One more inning, blank in every row, up to `MAX_PLAN_INNINGS`. */
export function addInning(plan: GamePlan): GamePlan {
  if (plan.innings >= MAX_PLAN_INNINGS) return plan
  const innings = plan.innings + 1
  return {
    ...plan,
    innings,
    rows: plan.rows.map(row => ({ ...row, cells: fitted(row.cells, innings) }))
  }
}

/** The plan's contents blanked: its toggle, innings and rows stay. */
export function clearPlan(plan: GamePlan): GamePlan {
  return {
    ...plan,
    rows: plan.rows.map(row => ({
      ...row,
      cells: fitted([], plan.innings)
    }))
  }
}

/**
 * Who a plan's row is across games: `g:<gumboId>`, or `n:<fullName>#<jersey>`
 * for a player made up at the field. History and same-day loads are keyed by
 * it.
 */
export function planPlayerKey(player: LineupPlayer): string {
  return player.gumboId != null
    ? `g:${player.gumboId}`
    : `n:${player.fullName}#${player.jersey}`
}

/**
 * A row's innings at each field position, and its sits, as a season's
 * history counts them; DH, EH and blank innings count in neither. Which
 * positions are infield is the Playing Time Rules' choice, so the warnings
 * make it.
 */
export interface PlanRowCounts {
  positions: Record<Position, number>
  sits: number
}

export function planRowCounts(cells: readonly PlanCell[]): PlanRowCounts {
  const positions = Object.fromEntries(
    POSITIONS.map(position => [position, 0])
  ) as Record<Position, number>
  for (const cell of cells) if (isPosition(cell)) positions[cell]++
  return { positions, sits: cells.filter(cell => cell === '-').length }
}

/**
 * The defence the plan's column for `inning` (from 1) gives the side, or
 * null when there is no such column or it changes nothing. Each batter is
 * found in the plan as `alignPlan` finds him.
 * - A batter planned at a field position takes it; when two are, the first
 *   in batting order does, and the other is read as unplanned.
 * - A batter planned at DH, EH or `-` leaves the field.
 * - An unplanned batter keeps his position if no planned batter takes it.
 * - A position nobody is given keeps its holder unless he was moved or left
 *   the field, and is otherwise empty.
 */
export function inningDefense(
  plan: GamePlan,
  inning: number,
  side: Pick<GameSide, 'battingOrder' | 'defense'>,
  players: Readonly<
    Record<number, Pick<GamePlayer, 'id' | 'fullName' | 'jersey' | 'local'>>
  >
): Record<Position, number | null> | null {
  if (inning < 1 || inning > plan.innings) return null
  const order = side.battingOrder.filter(id => players[id] != null)
  // Keyed as the coach's screen stores them (`planLineup`): a player made up
  // at the field has no gumboId, so only his name and jersey find his row.
  const rows = matchedRows(
    plan.rows,
    order.map(id => ({
      gumboId: players[id].local ? null : players[id].id,
      fullName: players[id].fullName,
      jersey: players[id].jersey
    }))
  )
  const next = Object.fromEntries(
    POSITIONS.map(position => [position, null])
  ) as Record<Position, number | null>
  const placed = new Set<number>()
  const left = new Set<number>()
  order.forEach((id, at) => {
    const cell = rows[at]?.cells[inning - 1] ?? ''
    if (isPosition(cell)) {
      if (next[cell] != null) return
      next[cell] = id
      placed.add(id)
    } else if (cell !== '') left.add(id)
  })
  for (const position of POSITIONS) {
    const holder = side.defense[position]
    if (next[position] != null || holder == null) continue
    if (placed.has(holder) || left.has(holder)) continue
    next[position] = holder
  }
  return POSITIONS.every(position => next[position] === side.defense[position])
    ? null
    : next
}
