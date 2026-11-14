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
 * fields; DH and EH bat without fielding; a blank sits. An inning whose
 * column holds no field position is not planned yet, blanks and all.
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
  'EH'
] as const
/** `''` is an inning on the bench. */
export type PlanCell = (typeof PLAN_CELLS)[number] | ''
export const DEFAULT_PLAN_INNINGS = 5
export const MAX_PLAN_INNINGS = 12

export interface GamePlanRow {
  player: LineupPlayer
  /** One per inning: `cells.length === innings`. */
  cells: PlanCell[]
}

export interface GamePlan {
  /**
   * Whether the scorekeeper's game moves the defence at each inning's end:
   * whether any cell holds a field position (`planHasPositions`), which the
   * server stores whatever a save sends.
   */
  enabled: boolean
  innings: number
  rows: GamePlanRow[]
}

export const OUTFIELD_POSITIONS = ['LF', 'CF', 'RF'] as const

const isPlanCell = (raw: string): raw is PlanCell =>
  raw === '' || PLAN_CELLS.includes(raw as (typeof PLAN_CELLS)[number])

/** The bench as plans saved before it was blank wrote it. */
const LEGACY_BENCH = '-'

/**
 * What a cell's text means: a value of `PLAN_CELLS` in any case, or `''`,
 * once trimmed. Anything else is null, which the plan never takes. A cell
 * holds two characters, so longer text (`SSS`, or `LF ` with its space) is
 * null before it is trimmed.
 */
export function planCellOf(text: string): PlanCell | null {
  if (text.length > 2) return null
  const cell = text.trim().toUpperCase()
  return isPlanCell(cell) ? cell : null
}

const asPlanCell: Cleaner<PlanCell> = raw => {
  if (raw === LEGACY_BENCH) return ''
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

/** Whether any cell of the plan holds a field position: whether it is on. */
export function planHasPositions(plan: Pick<GamePlan, 'rows'>): boolean {
  return plan.rows.some(row => row.cells.some(isPosition))
}

/**
 * Cleans a plan as it is saved and stored: whole innings from 1 to
 * `MAX_PLAN_INNINGS`, and in every row exactly one cell per inning, each a
 * value of `PLAN_CELLS` as it is stored (upper case, untrimmed) or blank. A
 * `-`, the bench of plans saved before it was blank, reads as blank. Anything
 * else is a `TypeError`, which the server answers with 400. `enabled` is
 * whatever the cells make it (`planHasPositions`), not what was sent.
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
  return { ...plan, enabled: planHasPositions(plan) }
}

/**
 * The value each first key completes to on the web: the one value it
 * starts, or for P and C the one-letter value itself.
 */
const COMPLETIONS: Readonly<Record<string, PlanCell>> = {
  P: 'P',
  C: 'C',
  '1': '1B',
  '2': '2B',
  '3': '3B',
  S: 'SS',
  L: 'LF',
  R: 'RF',
  D: 'DH',
  E: 'EH'
}

/**
 * What a key typed into a highlighted web cell writes, in either case:
 * `1` → 1B, `2` → 2B, `3` → 3B, `S` → SS, `L` → LF, `R` → RF, `D` → DH,
 * `E` → EH, `P` → P and `C` → C. Null for any other key.
 */
export function completeCell(first: string): PlanCell | null {
  return COMPLETIONS[first.toUpperCase()] ?? null
}

export type PlanCellEntry =
  { commit: PlanCell } | { pending: string } | { refuse: true }

/**
 * A key typed into a highlighted web cell, where `editing` is what the cell
 * is being given so far ('' before the first key). A first key commits its
 * completion (`completeCell`) at once, except C: C then F is CF, so C is
 * held pending, and F after it commits CF. Anything else is refused.
 */
export function planCellEntry(editing: string, key: string): PlanCellEntry {
  if (editing === '') {
    const cell = completeCell(key)
    if (cell == null) return { refuse: true }
    return cell === 'C' ? { pending: cell } : { commit: cell }
  }
  const cell = planCellOf(`${editing}${key}`)
  return cell == null || cell === editing ? { refuse: true } : { commit: cell }
}

const fitted = (cells: readonly PlanCell[], innings: number): PlanCell[] =>
  Array.from({ length: innings }, (_, inning) => {
    const cell = cells[inning] ?? ''
    // A plan held from before the bench was blank may still say `-`.
    return (cell as string) === LEGACY_BENCH ? '' : cell
  })

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
 * order, each with his stored cells (blank when he has none, and a `-` read
 * as blank), padded or cut to the plan's innings. A stored row nobody bats
 * in is dropped.
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

/**
 * One of the innings added past `DEFAULT_PLAN_INNINGS` deleted, every row's
 * cell with it, so the innings after it move up one. Innings 1 to
 * `DEFAULT_PLAN_INNINGS`, and an inning the plan does not have, stay.
 */
export function removeInning(plan: GamePlan, inning: number): GamePlan {
  if (inning <= DEFAULT_PLAN_INNINGS || inning > plan.innings) return plan
  return {
    ...plan,
    innings: plan.innings - 1,
    rows: plan.rows.map(row => ({
      ...row,
      cells: row.cells.filter((_, at) => at !== inning - 1)
    }))
  }
}

/**
 * The plan's contents blanked, which turns it off: its innings and rows
 * stay.
 */
export function clearPlan(plan: GamePlan): GamePlan {
  return {
    ...plan,
    enabled: false,
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
 * Which of the plan's innings are planned, one flag per inning: those whose
 * column holds a field position. A column of blanks, DH and EH gives no
 * instruction yet, so its blanks are not sits.
 */
export function plannedInnings(
  plan: Pick<GamePlan, 'innings' | 'rows'>
): boolean[] {
  return Array.from({ length: plan.innings }, (_, inning) =>
    plan.rows.some(row => isPosition(row.cells[inning]))
  )
}

/**
 * The defence the plan's column for `inning` (from 1) gives the side, or
 * null when there is no such column, it is not planned (none of the side's
 * batters has a field position in it), or it changes nothing. Each batter is
 * found in the plan as `alignPlan` finds him. A planned column applies whole:
 * - A batter planned at a field position takes it; when two are, the first
 *   in batting order does, and the other is read as unplanned.
 * - A batter planned at DH, EH or blank (the bench) leaves the field.
 * - A batter with no row is unplanned, and keeps his position if no planned
 *   batter takes it.
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
  const column = rows.map(row => row?.cells[inning - 1])
  if (!column.some(isPosition)) return null
  const placed = new Set<number>()
  const left = new Set<number>()
  order.forEach((id, at) => {
    const cell = column[at]
    if (cell == null) return
    if (isPosition(cell)) {
      if (next[cell] != null) return
      next[cell] = id
      placed.add(id)
    } else left.add(id)
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
