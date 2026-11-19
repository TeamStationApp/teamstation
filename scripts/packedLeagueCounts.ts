// Builds the synthetic packed league (src/test/packedLeagueRun.ts) and prints
// each season's games per team and its unmet lines, then replays the
// option's games, one by one, through the engine's own hard rules
// (`Occupancy`) and prints each one that does not fit.
//
//   node -r sucrase/register scripts/packedLeagueCounts.ts
//   node -r sucrase/register scripts/packedLeagueCounts.ts --recalculate
//   node -r sucrase/register scripts/packedLeagueCounts.ts --exhibitions
//   node -r sucrase/register scripts/packedLeagueCounts.ts --exhibitions --light
//
// The C++ engine (src/common/scheduler/engine.ts) builds it. With no flag it
// builds the league; `--recalculate` builds it, then recalculates every game
// of its option as required matchups; `--exhibitions` gives each season two
// exhibition teams and each participant two exhibition games, and `--light`
// with it asks half the regular games, which leaves field time for them.
import { buildContext } from '../src/common/autoScheduler/context'
import { Occupancy } from '../src/common/autoScheduler/feasibility'
import type {
  EngineInput,
  EngineResult,
  PlannedGame
} from '../src/common/autoScheduler/types'
import { buildSchedule } from '../src/common/scheduler/engine'
import { packedLeagueRun } from '../src/test/packedLeagueRun'

/** Replays games through `Occupancy`, printing each that breaks a rule. */
function replay(input: EngineInput, games: PlannedGame[]): number {
  const context = buildContext(input)
  const occupancy = new Occupancy(context)
  let violations = 0
  games.forEach((game, i) => {
    const season = context.seasonById.get(game.seasonId)
    const start = Date.parse(game.startAt)
    const slot = season?.slots.find(
      each => each.fieldId === game.fieldId && each.start === start
    )
    if (season == null || slot == null) {
      violations++
      console.log(`check: ${game.key} at ${game.startAt} is not a slot`)
      return
    }
    if (!occupancy.fits(season, game.homeTeamId, game.awayTeamId, slot)) {
      violations++
      console.log(`check: ${game.key} at ${game.startAt} breaks a hard rule`)
      return
    }
    occupancy.place(i, season, game.homeTeamId, game.awayTeamId, slot)
  })
  console.log(
    `check: ${games.length} games replayed through Occupancy, ${violations} violations`
  )
  return violations
}

/** Each season's games per team and its unmet lines. */
function report(input: EngineInput, result: EngineResult): void {
  if (result.blocking != null) console.log(`blocked: ${result.blocking}`)
  const [best] = result.options
  if (best == null) return
  const names = new Map(input.seasons.map(season => [season.id, season.name]))
  console.log(`games: ${best.games.length}`)
  for (const season of input.seasons) {
    const rows = best.fairness.filter(
      row => row.seasonId === season.id && !row.exhibitionTeam
    )
    const range = (counts: number[]): string =>
      `${Math.min(...counts)}–${Math.max(...counts)}`
    const exhibition =
      season.settings.exhibitionGames > 0
        ? `, exhibition ${range(rows.map(row => row.exhibitionGames))} of ${season.settings.exhibitionGames}`
        : ''
    console.log(
      `${season.name}: ${range(rows.map(row => row.regularGames))} of ${season.settings.regularGames}${exhibition}`
    )
  }
  for (const line of best.unmet)
    console.log(`${names.get(line.seasonId)}: ${line.message} — ${line.cause}`)
}

/** A build by the C++ engine, timed; a failure ends the script. */
async function engineBuild(
  what: string,
  input: EngineInput
): Promise<EngineResult> {
  const started = Date.now()
  const result = await buildSchedule({ input })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.kind === 'failure')
    throw new Error(`${what}: ${result.failure}: ${result.message}`)
  console.log(`${what}: built by the C++ engine in ${seconds} s`)
  return result
}

/** The league, then every game of its option recalculated as required matchups. */
async function recalculate(): Promise<number> {
  const input = packedLeagueRun()
  const built = await engineBuild('build', input)
  report(input, built)
  const [best] = built.options
  if (best == null) return 1
  const required = best.games.map(game => ({
    key: game.key,
    seasonId: game.seasonId,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    exhibition: game.exhibition
  }))
  console.log(`recalculating ${required.length} games as required matchups`)
  const again = { ...input, required }
  const result = await engineBuild('recalculation', again)
  report(again, result)
  const [placed] = result.options
  const keys = new Set(placed?.games.map(game => game.key) ?? [])
  const missing = required.filter(game => !keys.has(game.key)).length
  const changed = (placed?.games ?? []).filter(game => {
    const asked = required.find(each => each.key === game.key)
    return (
      asked?.homeTeamId !== game.homeTeamId ||
      asked.awayTeamId !== game.awayTeamId ||
      asked.exhibition !== game.exhibition
    )
  }).length
  console.log(
    `required: ${keys.size} of ${required.length} placed, ${missing} unplaced, ${changed} with keys, teams or type changed`
  )
  return replay(again, placed?.games ?? []) + missing + changed
}

/** The league with two exhibition teams a season and two exhibition games a participant. */
async function exhibitions(light: boolean): Promise<number> {
  const input = packedLeagueRun({
    seasons: season => ({
      ...season,
      exhibitionTeams: ['A', 'B'].map(
        letter => `tem_${season.id.slice(4)}guest${letter}`
      ),
      settings: {
        ...season.settings,
        exhibitionGames: 2,
        ...(light
          ? { regularGames: Math.floor(season.settings.regularGames / 2) }
          : {})
      }
    })
  })
  for (const season of input.seasons)
    for (const [i, team] of season.exhibitionTeams.entries())
      input.teamNames[team] = `${season.name} Guests ${i + 1}`
  const result = await engineBuild('exhibitions', input)
  if (result.kind !== 'options') return 1
  report(input, result)
  for (const target of result.targets)
    console.log(
      `${target.seasonId}: settled at ${target.regular} regular and ${target.exhibition} exhibition games`
    )
  return replay(input, result.options[0]?.games ?? [])
}

/** The league, built once. */
async function league(): Promise<number> {
  const input = packedLeagueRun()
  const result = await engineBuild('build', input)
  report(input, result)
  return replay(input, result.options[0]?.games ?? [])
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const problems = args.includes('--recalculate')
    ? await recalculate()
    : args.includes('--exhibitions')
      ? await exhibitions(args.includes('--light'))
      : await league()
  if (problems > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
