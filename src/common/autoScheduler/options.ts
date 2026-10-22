import type { RunContext } from './context'
import type { Placement } from './placement'
import {
  compareScores,
  DOUBLEHEADERS,
  firstNonZero,
  mixDeviation,
  SCARCITY,
  SPACING,
  type TeamTally,
  TIME_OF_DAY,
  TRUE_ORDER,
  UNPLACED,
  WEEKDAY
} from './score'
import type { GamePoint, Slot } from './slots'
import type { FairnessRow, PlannedGame } from './types'

/**
 * The three orders the search runs under: the true ranking, one that gives
 * up the day-of-week term first, and one that gives up the time-of-day term
 * first. Every candidate is still ranked by the true ranking.
 */
export const WEIGHTINGS: ReadonlyArray<readonly number[]> = [
  TRUE_ORDER,
  [UNPLACED, DOUBLEHEADERS, TIME_OF_DAY, SPACING, SCARCITY, WEEKDAY],
  [UNPLACED, DOUBLEHEADERS, SPACING, WEEKDAY, SCARCITY, TIME_OF_DAY]
]

/** The seeds each weighting runs from. */
export const SEEDS = 6

/** The most options a preview offers. */
export const MAX_OPTIONS = 3

/** The share of its games a later option must place on different slots. */
export const MIN_DIFFERENT = 0.25

/** A slot as options compare them: its field and start. */
function slotKey(slot: Slot): string {
  return `${slot.fieldId}|${slot.start}`
}

/**
 * The share of a candidate's games on a slot (a field and a start) that
 * the other schedule doesn't use.
 */
export function differentShare(candidate: Placement, other: Placement): number {
  const theirs = new Set<string>()
  for (const slot of other.slots) if (slot != null) theirs.add(slotKey(slot))
  let games = 0
  let different = 0
  for (const slot of candidate.slots) {
    if (slot == null) continue
    games++
    if (!theirs.has(slotKey(slot))) different++
  }
  return games === 0 ? 0 : different / games
}

/**
 * Up to three options from the candidates: the best by the true ranking,
 * then the next best each placing at least a quarter of its games on slots
 * different from every option already chosen. A candidate leaving more
 * games unplaced than the best never makes it, so counts stay equal.
 */
export function chooseOptions(candidates: Placement[]): Placement[] {
  const ranked = candidates
    .map((placement, i) => ({ placement, i }))
    .sort((a, b) =>
      firstNonZero(
        compareScores(a.placement.score, b.placement.score),
        a.i - b.i
      )
    )
    .map(entry => entry.placement)
  const [best] = ranked
  if (best == null) return []
  const chosen = [best]
  for (const candidate of ranked.slice(1)) {
    if (chosen.length >= MAX_OPTIONS) break
    if (candidate.score[UNPLACED] > best.score[UNPLACED]) continue
    if (
      chosen.every(option => differentShare(candidate, option) >= MIN_DIFFERENT)
    )
      chosen.push(candidate)
  }
  return chosen
}

const PARTS = ['in the morning', 'in the afternoon', 'in the evening']
const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays'
]

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

interface TeamView {
  name: string
  tally: TeamTally
  supply: { games: number; timeOfDay: number[]; weekdays: number[] }
}

function teamViews(context: RunContext, placement: Placement): TeamView[] {
  const views: TeamView[] = []
  for (const season of context.seasons) {
    const ledger = placement.ledgers.get(season.season.id)
    if (ledger == null) continue
    for (const [team, tally] of ledger.tallies)
      views.push({
        name: context.input.teamNames[team] ?? team,
        tally,
        supply: season.supply
      })
  }
  return views
}

/** The team whose share of a mix strays furthest past the season's, and where. */
function mixReason(
  views: TeamView[],
  bestViews: TeamView[],
  pick: (view: TeamView) => { counts: number[]; supply: number[] },
  labels: readonly string[]
): string | null {
  let found: { view: TeamView; by: number } | null = null
  views.forEach((view, i) => {
    const mine = pick(view)
    const theirs = pick(bestViews[i])
    const by =
      mixDeviation(
        mine.counts,
        view.tally.games,
        mine.supply,
        view.supply.games
      ) -
      mixDeviation(
        theirs.counts,
        bestViews[i].tally.games,
        theirs.supply,
        view.supply.games
      )
    if (by > 1e-9 && (found == null || by > found.by)) found = { view, by }
  })
  if (found == null) return null
  const { view } = found as { view: TeamView; by: number }
  const { counts, supply } = pick(view)
  let worst = 0
  let excess = -Infinity
  counts.forEach((count, i) => {
    const over =
      count / view.tally.games - supply[i] / Math.max(1, view.supply.games)
    if (over > excess) {
      excess = over
      worst = i
    }
  })
  return `${view.name} plays ${counts[worst]} of its ${plural(view.tally.games, 'game')} ${labels[worst]}`
}

function spacingReason(
  views: TeamView[],
  bestViews: TeamView[]
): string | null {
  let found: { view: TeamView; best: TeamView; by: number } | null = null
  views.forEach((view, i) => {
    const by = view.tally.spacing() - bestViews[i].tally.spacing()
    if (by > 1e-9 && (found == null || by > found.by))
      found = { view, best: bestViews[i], by }
  })
  if (found == null) return null
  const { view, best } = found as { view: TeamView; best: TeamView }
  const backToBack = view.tally.backToBack()
  if (backToBack > best.tally.backToBack())
    return `${view.name} has ${backToBack} games on back-to-back days`
  return `${view.name} goes ${Math.max(...view.tally.gaps())} days without a game`
}

function scarceGames(placement: Placement): number {
  return placement.slots.filter(slot => slot != null && slot.scarcity > 0)
    .length
}

/**
 * Why a later option trails Option 1, in plain words: one line for each
 * term it does worse on, most important first, at most two.
 */
export function optionReasons(
  context: RunContext,
  option: Placement,
  best: Placement
): string[] {
  const views = teamViews(context, option)
  const bestViews = teamViews(context, best)
  const reasons: string[] = []
  for (const term of TRUE_ORDER) {
    if (option.score[term] - best.score[term] <= 1e-9) continue
    let reason: string | null = null
    if (term === UNPLACED) {
      const more = option.score[term] - best.score[term]
      reason = `${plural(more, 'more game')} left unplaced`
    } else if (term === DOUBLEHEADERS) {
      const more = Math.round(option.score[term] - best.score[term])
      reason = plural(more, 'more doubleheader')
    } else if (term === TIME_OF_DAY)
      reason = mixReason(
        views,
        bestViews,
        view => ({
          counts: view.tally.timeOfDay,
          supply: view.supply.timeOfDay
        }),
        PARTS
      )
    else if (term === SPACING) reason = spacingReason(views, bestViews)
    else if (term === WEEKDAY)
      reason = mixReason(
        views,
        bestViews,
        view => ({ counts: view.tally.weekdays, supply: view.supply.weekdays }),
        WEEKDAYS.map(day => `on ${day}`)
      )
    else {
      const more = scarceGames(option) - scarceGames(best)
      reason =
        more > 0
          ? `${plural(more, 'more game')} on fields other seasons also need`
          : 'more use of fields other seasons also need'
    }
    if (reason != null) reasons.push(reason)
    if (reasons.length === 2) break
  }
  if (reasons.length === 0)
    reasons.push('Just as balanced as Option 1, at other dates and times')
  return reasons
}

/** Each team's line in the option's fairness summary, fixed games included. */
export function fairnessRows(
  context: RunContext,
  placement: Placement
): FairnessRow[] {
  const rows: FairnessRow[] = []
  for (const season of context.seasons) {
    const id = season.season.id
    const games = new Map<
      string,
      Array<{ point: GamePoint; exhibition: boolean }>
    >(season.teams.map(team => [team, []]))
    const add = (
      home: string,
      away: string,
      point: GamePoint,
      exhibition: boolean
    ): void => {
      games.get(home)?.push({ point, exhibition })
      games.get(away)?.push({ point, exhibition })
    }
    for (const { game, point } of season.fixed)
      add(game.homeTeamId, game.awayTeamId, point, game.exhibition)
    placement.matchups.forEach((matchup, i) => {
      const slot = placement.slots[i]
      if (matchup.seasonId === id && slot != null)
        add(matchup.homeTeamId, matchup.awayTeamId, slot, matchup.exhibition)
    })
    const exhibitionTeams = new Set(season.season.exhibitionTeams)
    for (const team of season.teams) {
      const list = games.get(team) ?? []
      // Gaps only between games inside the season's dates; the counts
      // still take every game of the season.
      const { startsOn, endsOn } = season.season.settings
      const days = list
        .filter(
          entry => entry.point.date >= startsOn && entry.point.date <= endsOn
        )
        .map(entry => entry.point.day)
        .sort((a, b) => a - b)
      const gaps = days.slice(1).map((day, i) => day - days[i])
      const perDay = new Map<number, number>()
      for (const { point } of list)
        perDay.set(point.day, (perDay.get(point.day) ?? 0) + 1)
      const weekdays = [0, 0, 0, 0, 0, 0, 0]
      for (const entry of list) weekdays[entry.point.weekday]++
      const part = (timeOfDay: number): number =>
        list.filter(entry => entry.point.timeOfDay === timeOfDay).length
      rows.push({
        teamId: team,
        seasonId: id,
        exhibitionTeam: exhibitionTeams.has(team),
        regularGames: list.filter(entry => !entry.exhibition).length,
        exhibitionGames: list.filter(entry => entry.exhibition).length,
        mornings: part(0),
        afternoons: part(1),
        evenings: part(2),
        weekdays,
        shortestGapDays: gaps.length === 0 ? null : Math.min(...gaps),
        longestGapDays: gaps.length === 0 ? null : Math.max(...gaps),
        doubleheaders: [...perDay.values()].reduce(
          (sum, count) => sum + count - 1,
          0
        )
      })
    }
  }
  return rows
}

/** The option's new games, earliest first. */
export function plannedGames(placement: Placement): PlannedGame[] {
  const out: Array<PlannedGame & { at: number }> = []
  placement.matchups.forEach((matchup, i) => {
    const slot = placement.slots[i]
    if (slot == null) return
    out.push({
      at: slot.start,
      key: matchup.key,
      seasonId: matchup.seasonId,
      homeTeamId: matchup.homeTeamId,
      awayTeamId: matchup.awayTeamId,
      exhibition: matchup.exhibition,
      fieldId: slot.fieldId,
      size: slot.size,
      startAt: new Date(slot.start).toISOString(),
      endAt: new Date(slot.end).toISOString()
    })
  })
  return out
    .sort((a, b) => firstNonZero(a.at - b.at, a.key.localeCompare(b.key)))
    .map(({ at, ...game }) => game)
}
