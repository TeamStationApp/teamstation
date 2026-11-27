// Sponsor features' rules, kept pure so the admin screens and the server
// apply the same ones. A check returns the sentence the screen shows, or
// `null`; a change that breaks a rule throws `SponsorRuleError` with that
// sentence.
import type {
  EventPlacement,
  PlacementDraft,
  PlacementProblems,
  SponsorState
} from './types'

/** A broken sponsor rule; its message is the sentence the screen shows. */
export class SponsorRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SponsorRuleError'
  }
}

/** The fields every credit row (a logo or a reel) has. */
export interface CreditRow {
  id: string
  name: string
  allocation: number
  used: number
  active: boolean
}

/** What a row's credits are called on its screen. */
export type CreditNoun = 'game logo' | 'broadcast'

/** The longest name a logo or reel row may have, in code points. */
export const NAME_LIMIT = 80
export const TITLE_LIMIT = 20
export const MESSAGE_LIMIT = 90
export const REEL_MIN_SEC = 10
export const REEL_MAX_SEC = 15
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000

const count = (value: number): string => value.toLocaleString('en-US')

/** The total less every row's allocation, active or inactive. */
export function remainingCredits(
  total: number,
  rows: ReadonlyArray<Pick<CreditRow, 'allocation'>>
): number {
  return rows.reduce((left, row) => left - row.allocation, total)
}

/**
 * Why `allocation` cannot be given to the row `id` (or to a new row when
 * `id` is `null`), or `null` when it can.
 */
export function allocationProblem(
  rows: readonly CreditRow[],
  total: number,
  id: string | null,
  allocation: number,
  noun: CreditNoun = 'game logo'
): string | null {
  const row = id == null ? null : rows.find(each => each.id === id)
  if (row?.active === false)
    return `${row.name} is inactive; its pool can't change.`
  if (!Number.isInteger(allocation) || allocation < 1)
    return 'Enter a whole number of credits, at least 1.'
  if (row != null && allocation < row.used)
    return `${row.name} has used ${count(row.used)}; its pool can't be smaller.`
  const available = remainingCredits(
    total,
    rows.filter(each => each.id !== id)
  )
  if (allocation > available)
    return `Only ${count(Math.max(0, available))} ${noun} credits are left to assign.`
  return null
}

function rowOf<Row extends CreditRow>(rows: readonly Row[], id: string): Row {
  const row = rows.find(each => each.id === id)
  if (row == null) throw new SponsorRuleError('That row is no longer listed.')
  return row
}

/**
 * Deactivates a row. A row with games used stays, inactive, keeping its
 * allocation counted; an unused row is removed, so its allocation returns.
 */
export function deactivated<Row extends CreditRow>(
  rows: readonly Row[],
  id: string
): Row[] {
  const row = rowOf(rows, id)
  if (row.used === 0) return rows.filter(each => each.id !== id)
  return rows.map(each => (each.id === id ? { ...each, active: false } : each))
}

/** The rows with `id`'s allocation set; throws if the rule refuses it. */
export function allocated<Row extends CreditRow>(
  rows: readonly Row[],
  total: number,
  id: string,
  allocation: number,
  noun: CreditNoun
): Row[] {
  rowOf(rows, id)
  const problem = allocationProblem(rows, total, id, allocation, noun)
  if (problem != null) throw new SponsorRuleError(problem)
  return rows.map(each => (each.id === id ? { ...each, allocation } : each))
}

export function logoFileProblem(file: { type: string }): string | null {
  return file.type === 'image/png' ? null : 'Logos must be PNG files.'
}

export function imageFileProblem(file: { type: string }): string | null {
  return file.type === 'image/jpeg' || file.type === 'image/png'
    ? null
    : 'Images must be JPEG or PNG.'
}

export function reelFileProblem(file: { type: string }): string | null {
  return file.type.startsWith('video/') ? null : 'Choose a video file.'
}

export function reelLengthProblem(durationSec: number): string | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0)
    return 'This video could not be read. Try another file.'
  if (durationSec >= REEL_MIN_SEC && durationSec <= REEL_MAX_SEC) return null
  const shown = Math.round(durationSec * 10) / 10
  return `This reel is ${shown} seconds. Reels must be ${REEL_MIN_SEC} to ${REEL_MAX_SEC} seconds long.`
}

/**
 * Length in code points, as the plan counts characters: a single-code-point
 * emoji counts as one.
 */
export const characters = (text: string): number => Array.from(text).length

export function titleProblem(title: string): string | null {
  if (title.trim() === '') return 'Enter a title.'
  return characters(title) > TITLE_LIMIT
    ? `Titles can be at most ${TITLE_LIMIT} characters.`
    : null
}

export function messageProblem(message: string): string | null {
  if (message.trim() === '') return 'Enter a message.'
  return characters(message) > MESSAGE_LIMIT
    ? `Messages can be at most ${MESSAGE_LIMIT} characters.`
    : null
}

/**
 * Only an address that begins with `https://` exactly, as typed, is placed:
 * the rows store it unchanged and the opener opens nothing else, so a
 * leading space or an uppercase scheme, which `URL` would quietly fix, is
 * refused here rather than placed as a row that opens nothing.
 */
export function urlProblem(url: string): string | null {
  if (!url.startsWith('https://')) return 'Use an https:// address.'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Use an https:// address.'
  }
  return parsed.protocol === 'https:' && parsed.hostname !== ''
    ? null
    : 'Use an https:// address.'
}

export function startsAtProblem(startsAt: string): string | null {
  return startsAt === '' || Number.isNaN(Date.parse(startsAt))
    ? 'Choose a date and time.'
    : null
}

/**
 * Each field of `draft` checked on its own. On an edit (`editing`), a
 * missing logo or background keeps the current one, so it is not a problem.
 */
export function placementProblems(
  draft: PlacementDraft,
  editing = false
): PlacementProblems {
  const problems: PlacementProblems = {}
  const image = (
    file: PlacementDraft['logo'],
    missing: string
  ): string | null =>
    file == null ? (editing ? null : missing) : imageFileProblem(file)
  const checks: Array<[keyof PlacementDraft, string | null]> = [
    ['logo', image(draft.logo, 'Choose a logo image.')],
    ['background', image(draft.background, 'Choose a background image.')],
    ['title', titleProblem(draft.title)],
    ['message', messageProblem(draft.message)],
    ['url', urlProblem(draft.url)],
    ['startsAt', startsAtProblem(draft.startsAt)]
  ]
  for (const [field, problem] of checks)
    if (problem != null) problems[field] = problem
  return problems
}

/** Slots not yet used by a placement, listed or deleted late. */
export function slotsLeft(
  state: Pick<SponsorState, 'totals' | 'placements' | 'keptSlots'>
): number {
  return state.totals.eventSlots - state.placements.length - state.keptSlots
}

/** True while fewer than 24 hours have passed since the placement. */
export function canEditPlacement(
  placement: Pick<EventPlacement, 'placedAt'>,
  now: Date
): boolean {
  return now.getTime() - Date.parse(placement.placedAt) < EDIT_WINDOW_MS
}

function placementOf(state: SponsorState, id: string): EventPlacement {
  const placement = state.placements.find(each => each.id === id)
  if (placement == null)
    throw new SponsorRuleError('That placement is no longer listed.')
  return placement
}

/** Throws unless a new placement has a slot. */
export function checkPlacementSlot(state: SponsorState): void {
  if (slotsLeft(state) <= 0)
    throw new SponsorRuleError('All event stream slots are used.')
}

/** Throws unless `id` may still be edited at `now`. */
export function checkPlacementEdit(
  state: SponsorState,
  id: string,
  now: Date
): EventPlacement {
  const placement = placementOf(state, id)
  if (!canEditPlacement(placement, now))
    throw new SponsorRuleError(
      'This placement is more than 24 hours old; it can only be deleted.'
    )
  return placement
}

/**
 * The state with `id` deleted. Within 24 hours of placement the slot
 * returns; after that it stays used, counted in `keptSlots`.
 */
export function placementDeleted(
  state: SponsorState,
  id: string,
  now: Date
): SponsorState {
  const placement = placementOf(state, id)
  return {
    ...state,
    placements: state.placements.filter(each => each.id !== id),
    keptSlots: state.keptSlots + (canEditPlacement(placement, now) ? 0 : 1)
  }
}
