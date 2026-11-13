import {
  blockingCause,
  capacityCause,
  type GameKind,
  managerCauseOfLeftovers,
  managerCauseOfOption,
  requestedTargets,
  requiredCause,
  seasonMatchups
} from './capacity'
import {
  buildContext,
  fullContextBytes,
  InvalidSubmission,
  type RunContext,
  type SeasonContext
} from './context'
import { requiredLines, unmetLines } from './counts'
import type { Matchup, Targets } from './matchups'
import { fairnessRows, optionReasons } from './options'
import type { Placement } from './placement'
import { addScores, SeasonLedger, TERMS } from './score'
import type { Slot } from './slots'
import type { EngineInput, EngineResult, ScheduleOption } from './types'

/** The most a full context for the causes may take in the validation worker. */
const FULL_CONTEXT_BYTES = 64 * 1024 * 1024
const UNPLACED_CAUSE =
  'The selected fields, time windows and constraints leave too little room for these games.'
const NO_OPTION_CAUSE =
  'No game fits the selected fields, time windows and constraints.'
const REQUIRED_CAUSE =
  'The selected fields, time windows and constraints leave no room for these games.'

/** Rebuild display summaries from accepted placements, without running a search. */
export function summarizeResult(
  input: EngineInput,
  result: EngineResult
): EngineResult {
  // A device that found nothing says so in its own words; the reason
  // stored is the engine's, from the server's input.
  if (result.options.length === 0)
    return {
      options: [],
      blocking:
        (fullContextBytes(input) > FULL_CONTEXT_BYTES
          ? null
          : blockingCause(buildContext(input))) ?? NO_OPTION_CAUSE
    }
  const context = buildContext(
    input,
    result.options.flatMap(option => option.games)
  )
  const slotsBySeason = new Map(
    context.seasons.map(season => [
      season.season.id,
      new Map(
        season.slots.map(slot => [
          `${slot.fieldId}|${slot.start}|${slot.end}`,
          slot
        ])
      )
    ])
  )
  // What the run had to place in each season, as the engine pairs it at
  // the requested counts. A run of required matchups places only those.
  const requestedMatchups = new Map(
    (context.required == null ? context.seasons : []).map(season => [
      season.season.id,
      seasonMatchups(
        context,
        season,
        requestedTargets(season),
        context.input.seed
      )
    ])
  )
  const placements = result.options.map((option): Placement => {
    const placedSlots = option.games.map(game => {
      const slot = slotsBySeason
        .get(game.seasonId)
        ?.get(
          `${game.fieldId}|${Date.parse(game.startAt)}|${Date.parse(game.endAt)}`
        )
      if (slot == null)
        throw new InvalidSubmission(
          'A proposed game is outside its season and field time windows'
        )
      return slot
    })
    const placedKeys = new Set(option.games.map(game => game.key))
    const missing: Matchup[] =
      context.required?.filter(matchup => !placedKeys.has(matchup.key)) ?? []
    const matchups: Matchup[] = [...option.games, ...missing]
    const slots: Array<Slot | null> = [
      ...placedSlots,
      ...missing.map(() => null)
    ]
    const ledgers = new Map<string, SeasonLedger>()
    for (const season of context.seasons) {
      const id = season.season.id
      const placed = option.games.filter(game => game.seasonId === id).length
      const games =
        context.required == null
          ? Math.max(placed, requestedMatchups.get(id)?.length ?? 0)
          : matchups.filter(matchup => matchup.seasonId === id).length
      const planned = new Map<string, number>()
      for (const game of [
        ...option.games.filter(game => game.seasonId === id),
        ...season.fixed
          .filter(
            ({ point }) =>
              point.day >= season.firstDay && point.day <= season.lastDay
          )
          .map(each => each.game)
      ])
        for (const team of [game.homeTeamId, game.awayTeamId])
          planned.set(team, (planned.get(team) ?? 0) + 1)
      const ledger = new SeasonLedger(season, games, planned)
      option.games.forEach((game, index) => {
        if (game.seasonId === id)
          ledger.add(
            game.homeTeamId,
            game.awayTeamId,
            placedSlots[index],
            placedSlots[index].scarcity
          )
      })
      ledgers.set(id, ledger)
    }
    return {
      matchups,
      slots,
      ledgers,
      score: [...ledgers.values()].reduce(
        (total, ledger) => addScores(total, ledger.score()),
        Array<number>(TERMS).fill(0)
      )
    }
  })
  // The causes read the run's availability as the engine's search did: a
  // context with occupancy and every slot, built only when a line needs one,
  // and only when it fits the validation worker's memory. A run too large
  // for that gets a plain cause instead.
  let fullContext: RunContext | null | undefined
  const full = (): RunContext | null =>
    (fullContext ??=
      fullContextBytes(input) > FULL_CONTEXT_BYTES ? null : buildContext(input))
  const fullSeason = (
    context: RunContext,
    season: SeasonContext
  ): SeasonContext => context.seasonById.get(season.season.id)!
  const causes = new Map<string, string>()
  const causeOf = (
    season: SeasonContext,
    kind: GameKind,
    requested: number
  ): string => {
    const key = `${season.season.id}|${kind}`
    let cause = causes.get(key)
    if (cause == null) {
      const context = full()
      cause =
        context == null
          ? UNPLACED_CAUSE
          : capacityCause(context, fullSeason(context, season), kind, requested)
      causes.set(key, cause)
    }
    return cause
  }
  const requiredCauseOf = (
    season: SeasonContext,
    unplaced: Matchup[]
  ): string => {
    const context = full()
    return context == null
      ? REQUIRED_CAUSE
      : requiredCause(context, fullSeason(context, season), unplaced)
  }
  return {
    blocking: null,
    options: result.options.map((option, index): ScheduleOption => {
      const placement = placements[index]
      let manager: ReturnType<typeof managerCauseOfOption> | undefined
      const placedCause = (
        season: SeasonContext,
        unplaced: Matchup[]
      ): string | undefined => {
        if (input.headCoaches == null || unplaced.length === 0) return
        const context = full()
        if (context == null) return
        manager ??= managerCauseOfOption(context, placement)
        return manager(fullSeason(context, season), unplaced)
      }
      let leftovers: ReturnType<typeof managerCauseOfLeftovers> | undefined
      const leftoverCause = (
        season: SeasonContext,
        unplaced: Matchup[]
      ): string | undefined => {
        if (input.headCoaches == null || unplaced.length === 0) return
        const context = full()
        if (context == null) return
        leftovers ??= managerCauseOfLeftovers(context, placement)
        return leftovers(fullSeason(context, season), unplaced)
      }
      return {
        games: option.games,
        fairness: fairnessRows(context, placement),
        unmet:
          context.required == null
            ? unmetLines(
                context,
                reachedTargets(context.seasons, placement, requestedMatchups),
                placement,
                (season, kind, requested) =>
                  leftoverCause(
                    season,
                    leftOver(
                      requestedMatchups.get(season.season.id) ?? [],
                      option.games,
                      kind === 'exhibition'
                    )
                  ) ?? causeOf(season, kind, requested)
              )
            : requiredLines(
                context,
                placement,
                (season, unplaced) =>
                  placedCause(season, unplaced) ??
                  requiredCauseOf(season, unplaced)
              ),
        score: placement.score.map(value => Math.round(value * 1e6) / 1e6),
        reasons:
          index === 0 ? [] : optionReasons(context, placement, placements[0])
      }
    })
  }
}

/**
 * The counts an option reached, in place of the engine's settled targets:
 * the requested count where every playing team got the games it needed, or
 * where the run had none of that kind to place, and otherwise below it, so
 * the option reports the shortfall the way the engine does.
 */
function reachedTargets(
  seasons: readonly SeasonContext[],
  placement: Placement,
  requestedMatchups: Map<string, Matchup[]>
): Map<string, Targets> {
  const targets = new Map<string, Targets>()
  for (const season of seasons) {
    const id = season.season.id
    const requested = requestedTargets(season)
    const target = { ...requested }
    for (const kind of ['regular', 'exhibition'] as const) {
      const exhibition = kind === 'exhibition'
      const wanted = new Map<string, number>()
      for (const matchup of requestedMatchups.get(id) ?? [])
        if (matchup.exhibition === exhibition)
          for (const team of [matchup.homeTeamId, matchup.awayTeamId])
            wanted.set(team, (wanted.get(team) ?? 0) + 1)
      if (wanted.size === 0) continue
      const got = new Map<string, number>()
      placement.matchups.forEach((matchup, i) => {
        if (
          matchup.seasonId !== id ||
          matchup.exhibition !== exhibition ||
          placement.slots[i] == null
        )
          return
        for (const team of [matchup.homeTeamId, matchup.awayTeamId])
          got.set(team, (got.get(team) ?? 0) + 1)
      })
      for (const [team, count] of wanted)
        if ((got.get(team) ?? 0) < count) target[kind] = requested[kind] - 1
    }
    targets.set(id, target)
  }
  return targets
}

/**
 * The requested matchups of a kind an option didn't place, pair by pair:
 * the engine's unplaced games, as near as the server can tell without its
 * search. A Manager/Head Coach the option's own games keep busy shows here.
 */
function leftOver(
  requested: readonly Matchup[],
  placed: readonly Matchup[],
  exhibition: boolean
): Matchup[] {
  const pair = (game: Matchup): string =>
    [game.homeTeamId, game.awayTeamId].sort().join('\u0000')
  const counts = new Map<string, number>()
  for (const game of placed)
    if (game.exhibition === exhibition)
      counts.set(pair(game), (counts.get(pair(game)) ?? 0) + 1)
  return requested.filter(game => {
    if (game.exhibition !== exhibition) return false
    const left = counts.get(pair(game)) ?? 0
    if (left === 0) return true
    counts.set(pair(game), left - 1)
    return false
  })
}
