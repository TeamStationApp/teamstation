import { buildContext } from './context'
import { fairnessRows, optionReasons } from './options'
import type { Placement } from './placement'
import { addScores, SeasonLedger, TERMS } from './score'
import type { EngineInput, EngineResult, ScheduleOption } from './types'

/** Rebuild display summaries from accepted placements, without running a search. */
export function summarizeResult(
  input: EngineInput,
  result: EngineResult
): EngineResult {
  if (result.options.length === 0) return result
  const context = buildContext(
    input,
    result.options.flatMap(option => option.games)
  )
  const placements = result.options.map((option): Placement => {
    const slots = option.games.map(game => {
      const season = context.seasons.find(
        each => each.season.id === game.seasonId
      )!
      const slot = season.slots.find(
        each =>
          each.fieldId === game.fieldId &&
          each.start === Date.parse(game.startAt) &&
          each.end === Date.parse(game.endAt)
      )
      if (slot == null)
        throw new TypeError(
          'A proposed game is outside its season and field time windows'
        )
      return slot
    })
    const ledgers = new Map<string, SeasonLedger>()
    for (const season of context.seasons) {
      const games = option.games.filter(
        game => game.seasonId === season.season.id
      )
      const planned = new Map<string, number>()
      for (const game of [...games, ...season.fixed.map(each => each.game)])
        for (const team of [game.homeTeamId, game.awayTeamId])
          planned.set(team, (planned.get(team) ?? 0) + 1)
      const ledger = new SeasonLedger(season, games.length, planned)
      option.games.forEach((game, index) => {
        if (game.seasonId === season.season.id)
          ledger.add(
            game.homeTeamId,
            game.awayTeamId,
            slots[index],
            slots[index].scarcity
          )
      })
      ledgers.set(season.season.id, ledger)
    }
    return {
      matchups: option.games,
      slots,
      ledgers,
      score: [...ledgers.values()].reduce(
        (total, ledger) => addScores(total, ledger.score()),
        Array<number>(TERMS).fill(0)
      )
    }
  })
  return {
    blocking: null,
    options: result.options.map((option, index): ScheduleOption => {
      const fairness = fairnessRows(context, placements[index])
      const unmet = input.seasons.flatMap(season => {
        const rows = fairness.filter(
          row => row.seasonId === season.id && !row.exhibitionTeam
        )
        const missing = rows.reduce(
          (total, row) =>
            total +
            Math.max(0, season.settings.regularGames - row.regularGames) +
            Math.max(0, season.settings.exhibitionGames - row.exhibitionGames),
          0
        )
        if (input.required != null) {
          const missingRequired = input.required.filter(
            game =>
              game.seasonId === season.id &&
              !option.games.some(placed => placed.key === game.key)
          ).length
          return missingRequired === 0
            ? []
            : [
                {
                  seasonId: season.id,
                  message: `${missingRequired} requested games remain unplaced`,
                  cause:
                    'The submitted option could not place every requested game.'
                }
              ]
        }
        return missing === 0
          ? []
          : [
              {
                seasonId: season.id,
                message: `${missing} requested team games remain unplaced`,
                cause:
                  'The submitted option leaves requested games unplaced within the selected constraints.'
              }
            ]
      })
      return {
        games: option.games,
        fairness,
        unmet,
        score: placements[index].score.map(
          value => Math.round(value * 1e6) / 1e6
        ),
        reasons:
          index === 0
            ? []
            : optionReasons(context, placements[index], placements[0])
      }
    })
  }
}
