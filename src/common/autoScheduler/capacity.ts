import { fieldSizeLabel } from '../venues'
import { openSlots, type RunContext, type SeasonContext } from './context'
import {
  buildMatchups,
  fixedCounts,
  type Matchup,
  seasonNeeds,
  type Targets
} from './matchups'
import { mulberry32 } from './random'
import { firstNonZero } from './score'
import { alignUp, MINUTE } from './slots'

/** Which of a season's counts a line is about. */
export type GameKind = 'regular' | 'exhibition'

/** The counts a season's settings ask for. */
export function requestedTargets(season: SeasonContext): Targets {
  const { regularGames, exhibitionGames } = season.season.settings
  return { regular: regularGames, exhibition: exhibitionGames }
}

/** A season's matchups at some targets, paired in the seed's order. */
export function seasonMatchups(
  context: RunContext,
  season: SeasonContext,
  targets: Targets,
  seed: number
): Matchup[] {
  return buildMatchups(
    season.season,
    targets,
    context.input.fixed,
    context.active,
    mulberry32(seed ^ 0x5eed)
  )
}

/** The time on a field held by bookings and other games, with no season of its own to pad it. */
function fieldHolds(
  context: RunContext,
  fieldId: string
): Array<{ start: number; end: number }> {
  return [
    ...context.input.bookings.filter(booking => booking.fieldId === fieldId),
    ...context.input.fixed.filter(game => game.fieldId === fieldId)
  ].map(hold => ({ start: hold.start, end: hold.end }))
}

/**
 * The most new games the season's field time could hold, games packed back
 * to back with the season's buffer between them, around what already holds
 * the fields. Other seasons of the run sharing a field aren't subtracted,
 * so this is an upper bound.
 */
export function fieldCapacity(
  context: RunContext,
  season: SeasonContext
): number {
  const { gameMinutes } = season.season.settings
  const gameMs = gameMinutes * MINUTE
  const stride = gameMs + season.bufferMs
  const holds = new Map<string, Array<{ start: number; end: number }>>()
  let games = 0
  for (const window of season.windows) {
    let held = holds.get(window.fieldId)
    if (held == null) {
      held = fieldHolds(context, window.fieldId)
      holds.set(window.fieldId, held)
    }
    let free = [{ start: window.start, end: window.end }]
    for (const hold of held) {
      const blockedStart = hold.start - season.bufferMs
      const blockedEnd = hold.end + season.bufferMs
      free = free.flatMap(part => {
        if (blockedEnd <= part.start || part.end <= blockedStart) return [part]
        const out = []
        if (blockedStart > part.start)
          out.push({ start: part.start, end: blockedStart })
        if (blockedEnd < part.end)
          out.push({ start: blockedEnd, end: part.end })
        return out
      })
    }
    for (const part of free) {
      const start = alignUp(part.start)
      if (start + gameMs <= part.end)
        games += Math.floor((part.end - start - gameMs) / stride) + 1
    }
  }
  return games
}

/**
 * How many games a team could play with its own commitments in the way: on
 * each date, the most slots it can take one after another (one a day in a
 * season that never plays doubleheaders), counting only slots whose field
 * is free.
 */
export function teamCapacity(
  season: SeasonContext,
  team: string,
  ownTime: boolean
): number {
  const free = season.teamFree.get(team)
  const perDay = season.season.settings.doubleheaders === 'never' ? 1 : Infinity
  let games = 0
  let date = ''
  let today = 0
  let busyUntil = -Infinity
  season.slots
    .map((slot, i) => ({ slot, i }))
    .filter(
      ({ i }) => season.fieldFree[i] === 1 && (!ownTime || free?.[i] === 1)
    )
    .sort((a, b) =>
      firstNonZero(
        a.slot.date.localeCompare(b.slot.date),
        a.slot.end - b.slot.end
      )
    )
    .forEach(({ slot }) => {
      if (slot.date !== date) {
        date = slot.date
        today = 0
        busyUntil = -Infinity
      }
      if (today < perDay && slot.start >= busyUntil) {
        today++
        games++
        busyUntil = slot.end
      }
    })
  return games
}

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * Why a season can't have the count it asked for, phrased against that
 * count: not enough field time of its size, or a team whose own games
 * leave it too few open dates.
 */
export function capacityCause(
  context: RunContext,
  season: SeasonContext,
  kind: GameKind,
  requested: number
): string {
  const settings = season.season.settings
  const what = kind === 'regular' ? 'game' : 'exhibition game'
  const fieldTime = `not enough ${fieldSizeLabel(settings.fieldSize)} field time to give every team ${plural(requested, what)}`
  const targets = requestedTargets(season)
  const needed = seasonMatchups(
    context,
    season,
    targets,
    context.input.seed
  ).length
  if (needed > fieldCapacity(context, season)) return fieldTime

  const own = context.input.fixed.filter(
    game => game.seasonId === season.season.id
  )
  const needs = seasonNeeds(
    season.season,
    targets,
    fixedCounts(season.season, own),
    context.active
  )
  let short: { team: string; by: number } | null = null
  for (const team of season.season.participants) {
    const need = needs.get(team)
    const total = (need?.regular ?? 0) + (need?.exhibition ?? 0)
    if (total === 0) continue
    const open = teamCapacity(season, team, true)
    if (open >= total || open >= teamCapacity(season, team, false)) continue
    if (short == null || total - open > short.by)
      short = { team, by: total - open }
  }
  if (short == null) return fieldTime
  const name = context.input.teamNames[short.team] ?? short.team
  return `${name}’s existing games leave too few open dates`
}

/**
 * When the run can place no new game at all while some participant still
 * needs games, the reason: the first such season's cause. Null when at least
 * one game fits somewhere.
 */
export function blockingCause(context: RunContext): string | null {
  if (context.required != null) return requiredBlockingCause(context)
  let blocked: SeasonContext | null = null
  for (const season of context.seasons) {
    const matchups = seasonMatchups(
      context,
      season,
      requestedTargets(season),
      context.input.seed
    )
    if (matchups.length === 0) continue
    if (
      matchups.some(
        game => openSlots(season, game.homeTeamId, game.awayTeamId) > 0
      )
    )
      return null
    blocked ??= season
  }
  if (blocked == null) return null
  const targets = requestedTargets(blocked)
  return targets.regular > 0
    ? capacityCause(context, blocked, 'regular', targets.regular)
    : capacityCause(context, blocked, 'exhibition', targets.exhibition)
}

/**
 * Why required matchups couldn’t be placed: not enough field time of the
 * season's size for all of them, or, for a matchup with no open slot at
 * all, the team whose own games leave it the fewest.
 */
export function requiredCause(
  context: RunContext,
  season: SeasonContext,
  unplaced: readonly Matchup[]
): string {
  const settings = season.season.settings
  const required = (context.required ?? []).filter(
    matchup => matchup.seasonId === season.season.id
  ).length
  const fieldTime = `not enough ${fieldSizeLabel(settings.fieldSize)} field time to place ${plural(required, 'game')} again`
  if (required > fieldCapacity(context, season)) return fieldTime
  const fieldOpen = season.fieldFree.reduce((sum, free) => sum + free, 0)
  for (const matchup of unplaced) {
    if (
      fieldOpen === 0 ||
      openSlots(season, matchup.homeTeamId, matchup.awayTeamId) > 0
    )
      continue
    const freeFor = (team: string): number => {
      const free = season.teamFree.get(team)
      let count = 0
      season.fieldFree.forEach((open, i) => {
        count += open & (free?.[i] ?? 0)
      })
      return count
    }
    const team =
      freeFor(matchup.homeTeamId) <= freeFor(matchup.awayTeamId)
        ? matchup.homeTeamId
        : matchup.awayTeamId
    const name = context.input.teamNames[team] ?? team
    return `${name}’s existing games leave too few open dates`
  }
  return fieldTime
}

/**
 * When none of the required matchups can be placed anywhere, the first
 * season's cause; null when at least one fits, or there are none to place.
 */
function requiredBlockingCause(context: RunContext): string | null {
  const required = context.required ?? []
  if (required.length === 0) return null
  for (const matchup of required) {
    const season = context.seasonById.get(matchup.seasonId)
    if (
      season != null &&
      openSlots(season, matchup.homeTeamId, matchup.awayTeamId) > 0
    )
      return null
  }
  const season = context.seasons.find(each =>
    required.some(matchup => matchup.seasonId === each.season.id)
  )
  if (season == null) return null
  return requiredCause(
    context,
    season,
    required.filter(matchup => matchup.seasonId === season.season.id)
  )
}
