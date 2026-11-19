import { type FieldSize, fieldSizeLabel } from '../venues'

/**
 * The Auto-Scheduler's causes and unmet counts in today's words. The C++
 * engine (native/scheduler) computes every cause — the pre-solve block, the
 * field and team capacities, the managers, the week parts, the required
 * matchups — and reports it structured; every sentence a person reads is
 * written here, so the words stay in TypeScript.
 */

export type GameKind = 'regular' | 'exhibition'

/** The cause a binding weekday or weekend maximum gives. */
export const WEEK_PARTS_CAUSE =
  'this season’s weekday/weekend game maximums leave too few available games'

/** The cause the never-doubleheaders rule gives. */
export const DOUBLEHEADERS_CAUSE = 'teams may not play twice in a day'

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

/** The first of several comparisons that is not a tie. */
const firstNonZero = (...values: number[]): number =>
  values.find(value => value !== 0) ?? 0

const KIND_WORDS: Record<GameKind, string> = {
  regular: 'regular-season game',
  exhibition: 'exhibition game'
}

function gamesOf(kind: GameKind, count: number): string {
  return `${KIND_WORDS[kind]}${count === 1 ? '' : 's'}`
}

/** "every team gets 11 of the 12 requested regular-season games" */
export function equalLine(
  kind: GameKind,
  total: number,
  requested: number
): string {
  return `every team gets ${total} of the ${requested} requested ${gamesOf(kind, requested)}`
}

/**
 * The uneven totals team by team, the largest group last as "the others":
 * "Demo Hawks gets 9 of 12 regular-season games; the others get 10 of 12".
 */
export function totalsLine(
  kind: GameKind,
  totals: Array<{ name: string; total: number }>,
  requested: number
): string {
  const groups = new Map<number, string[]>()
  for (const { name, total } of totals)
    groups.set(total, [...(groups.get(total) ?? []), name])
  if (groups.size <= 1) return equalLine(kind, totals[0]?.total ?? 0, requested)
  const [largest] = [...groups].sort((a, b) =>
    firstNonZero(b[1].length - a[1].length, b[0] - a[0])
  )
  const others = largest[1].length > 1 ? largest[0] : null
  const named = totals
    .filter(entry => entry.total !== others)
    .sort((a, b) =>
      firstNonZero(a.total - b.total, a.name.localeCompare(b.name))
    )
  const clauses = named.map(
    ({ name, total }, i) =>
      `${name} gets ${total} of ${requested}${i === 0 ? ` ${gamesOf(kind, requested)}` : ''}`
  )
  if (others != null) clauses.push(`the others get ${others} of ${requested}`)
  return clauses.join('; ')
}

/** "1 of the 3 games to place again couldn’t be placed" */
export function requiredLine(unplaced: number, required: number): string {
  return `${unplaced} of the ${required} ${required === 1 ? 'game' : 'games'} to place again couldn’t be placed`
}

/** The cause of every short season in a schedule taken at the time limit. */
export const TIME_LIMIT_CAUSE = 'Not proven optimal: stopped at the time limit'

/** The rule a structured cause names, as the C++ engine reports it. */
export type CauseRule =
  | 'fieldTime'
  | 'weekParts'
  | 'doubleheaders'
  | 'manager'
  | 'requiredUnplaced'
  | 'teamOpenDates'
  | 'capacity'
  | 'timeLimit'

/**
 * Why a season stops short, as the C++ engine (native/scheduler) gives it:
 * a rule proven by relaxing it in the model, or found by its capacity
 * heuristics (`capacity`, worded as field time), or, for a schedule the admin
 * took at the time limit, `timeLimit`. `requested` is the count the
 * season asked for, or, for required matchups, how many it had to place.
 */
export interface Cause {
  seasonId: string
  kind: GameKind | 'required'
  rule: CauseRule
  teamId?: string
  managerId?: string
  requested: number
  size: FieldSize
}

/** A structured cause in today's words. */
export function causeLine(
  cause: Cause,
  context: { teamNames: Record<string, string> }
): string {
  const name = context.teamNames[cause.teamId ?? ''] ?? cause.teamId ?? ''
  const field = `not enough ${fieldSizeLabel(cause.size)} field time`
  switch (cause.rule) {
    case 'weekParts':
      return WEEK_PARTS_CAUSE
    case 'doubleheaders':
      return DOUBLEHEADERS_CAUSE
    case 'manager':
      return `${name}’s Manager/Head Coach is booked during otherwise available game times`
    case 'teamOpenDates':
      return `${name}’s existing games leave too few open dates`
    case 'requiredUnplaced':
      return `${field} to place ${plural(cause.requested, 'game')} again`
    case 'timeLimit':
      return TIME_LIMIT_CAUSE
    default:
      return `${field} to give every team ${plural(cause.requested, cause.kind === 'exhibition' ? 'exhibition game' : 'game')}`
  }
}
