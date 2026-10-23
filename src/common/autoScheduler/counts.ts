import {
  fieldCapacity,
  type GameKind,
  requestedTargets,
  seasonMatchups,
  teamCapacity
} from './capacity'
import type { RunContext, SeasonContext } from './context'
import {
  fixedCounts,
  type Matchup,
  seasonNeeds,
  type Targets
} from './matchups'
import { place, type Placement } from './placement'
import { firstNonZero } from './score'
import type { UnmetConstraint } from './types'

/**
 * The lowest a season's targets may go: the highest fixed count of any
 * participant, by type, since fixed games are never cancelled. Never above
 * what the season asks for.
 */
export function floorTargets(season: SeasonContext): Targets {
  const requested = requestedTargets(season)
  const counts = fixedCounts(
    season.season,
    season.fixed.map(entry => entry.game)
  )
  let regular = 0
  let exhibition = 0
  for (const team of season.season.participants) {
    const count = counts.get(team)
    regular = Math.max(regular, count?.regular ?? 0)
    exhibition = Math.max(exhibition, count?.exhibition ?? 0)
  }
  return {
    regular: Math.min(regular, requested.regular),
    exhibition: Math.min(exhibition, requested.exhibition)
  }
}

function needsAt(
  context: RunContext,
  season: SeasonContext,
  targets: Targets
): Map<string, { regular: number; exhibition: number }> {
  return seasonNeeds(
    season.season,
    targets,
    fixedCounts(
      season.season,
      season.fixed.map(entry => entry.game)
    ),
    context.active
  )
}

/** Whether the regular-season games at the targets add up to an odd number of team games. */
function oddTotal(
  context: RunContext,
  season: SeasonContext,
  targets: Targets
): boolean {
  let total = 0
  for (const need of needsAt(context, season, targets).values())
    total += need.regular
  return total % 2 === 1
}

/**
 * Lowers a season's targets by one step: regular first, then exhibition.
 * A regular target whose team games would add up to an odd number, which
 * would leave one team a game short, is passed over unless the season asked
 * for an odd total itself. False when both are already at the floor.
 */
export function lowerTargets(
  context: RunContext,
  season: SeasonContext,
  targets: Targets
): boolean {
  const floor = floorTargets(season)
  if (targets.regular > floor.regular) {
    const oddAsked = oddTotal(context, season, requestedTargets(season))
    targets.regular--
    if (!oddAsked)
      while (
        targets.regular > floor.regular &&
        oddTotal(context, season, targets)
      )
        targets.regular--
    return true
  }
  if (targets.exhibition > floor.exhibition) {
    targets.exhibition--
    return true
  }
  return false
}

/**
 * Where a season's search starts: its requested counts, lowered step by
 * step past any count that can't fit the field time or a participant's own
 * open time, which no search could place.
 */
export function startingTargets(
  context: RunContext,
  season: SeasonContext,
  seed: number
): Targets {
  const targets = requestedTargets(season)
  const capacity = fieldCapacity(context, season)
  const open = new Map(
    season.season.participants.map(team => [
      team,
      teamCapacity(season, team, true)
    ])
  )
  const fits = (): boolean => {
    if (seasonMatchups(context, season, targets, seed).length > capacity)
      return false
    for (const [team, need] of needsAt(context, season, targets))
      if (need.regular + need.exhibition > (open.get(team) ?? 0)) return false
    return true
  }
  while (!fits() && lowerTargets(context, season, targets));
  return targets
}

/** Every season's matchups at the targets, in season order. */
export function runMatchups(
  context: RunContext,
  targets: Map<string, Targets>,
  seed: number
): Matchup[] {
  if (context.required != null) return context.required
  return context.seasons.flatMap(season =>
    seasonMatchups(
      context,
      season,
      targets.get(season.season.id) ?? requestedTargets(season),
      seed
    )
  )
}

/** The targets every option is built at, and the search that settled them. */
export interface Settled {
  targets: Map<string, Targets>
  placement: Placement
}

/**
 * Equal counts. While a season has games left unplaced, every team's target
 * drops by one, regular first, then exhibition, and the search runs again,
 * until everything places or the season reaches its floor. At the floor the
 * search places what it can, every need clamped at zero.
 */
export function settleTargets(
  context: RunContext,
  seed: number,
  order?: readonly number[]
): Settled {
  // Required matchups are placed as they are, with no lowering.
  if (context.required != null)
    return {
      targets: new Map(
        context.seasons.map(season => [
          season.season.id,
          requestedTargets(season)
        ])
      ),
      placement: place(context, context.required, seed, order)
    }
  const targets = new Map(
    context.seasons.map(season => [
      season.season.id,
      startingTargets(context, season, seed)
    ])
  )
  for (;;) {
    const placement = place(
      context,
      runMatchups(context, targets, seed),
      seed,
      order
    )
    let lowered = false
    for (const season of context.seasons) {
      const ledger = placement.ledgers.get(season.season.id)
      const current = targets.get(season.season.id)
      if (ledger == null || current == null || ledger.placed === ledger.games)
        continue
      if (lowerTargets(context, season, current)) lowered = true
    }
    if (!lowered) return { targets, placement }
  }
}

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

/**
 * The counts an option couldn't give, each with its cause, wherever a
 * season's target was lowered or games still went unplaced at the floor:
 * one line when every team ends up with the same total, otherwise the
 * totals team by team.
 */
export function unmetLines(
  context: RunContext,
  targets: Map<string, Targets>,
  placement: Placement,
  causeOf: (season: SeasonContext, kind: GameKind, requested: number) => string
): UnmetConstraint[] {
  const out: UnmetConstraint[] = []
  for (const season of context.seasons) {
    const id = season.season.id
    const requested = requestedTargets(season)
    const target = targets.get(id) ?? requested
    const teams = season.season.participants.filter(
      team => context.active == null || context.active.has(team)
    )
    for (const kind of ['regular', 'exhibition'] as const) {
      if (requested[kind] === 0) continue
      const exhibition = kind === 'exhibition'
      let unplaced = 0
      const totals = new Map(teams.map(team => [team, 0]))
      const count = (team: string): void => {
        const total = totals.get(team)
        if (total != null) totals.set(team, total + 1)
      }
      for (const { game } of season.fixed)
        if (game.exhibition === exhibition) {
          count(game.homeTeamId)
          count(game.awayTeamId)
        }
      placement.matchups.forEach((matchup, i) => {
        if (matchup.seasonId !== id || matchup.exhibition !== exhibition) return
        if (placement.slots[i] == null) unplaced++
        else {
          count(matchup.homeTeamId)
          count(matchup.awayTeamId)
        }
      })
      if (teams.length === 0) continue
      if (unplaced === 0 && target[kind] >= requested[kind]) continue
      const message = totalsLine(
        kind,
        teams.map(team => ({
          name: context.input.teamNames[team] ?? team,
          total: totals.get(team) ?? 0
        })),
        requested[kind]
      )
      out.push({
        seasonId: id,
        message,
        cause: causeOf(season, kind, requested[kind])
      })
    }
  }
  return out
}

/** "1 of the 3 games to place again couldn’t be placed" */
export function requiredLine(unplaced: number, required: number): string {
  return `${unplaced} of the ${required} ${required === 1 ? 'game' : 'games'} to place again couldn’t be placed`
}

/**
 * The required matchups an option couldn't place, one line per season with
 * any left over, each with its cause.
 */
export function requiredLines(
  context: RunContext,
  placement: Placement,
  causeOf: (season: SeasonContext, unplaced: Matchup[]) => string
): UnmetConstraint[] {
  const out: UnmetConstraint[] = []
  for (const season of context.seasons) {
    const id = season.season.id
    let required = 0
    const unplaced: Matchup[] = []
    placement.matchups.forEach((matchup, i) => {
      if (matchup.seasonId !== id) return
      required++
      if (placement.slots[i] == null) unplaced.push(matchup)
    })
    if (unplaced.length === 0) continue
    out.push({
      seasonId: id,
      message: requiredLine(unplaced.length, required),
      cause: causeOf(season, unplaced)
    })
  }
  return out
}
