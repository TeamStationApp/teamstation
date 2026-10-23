import { type Random, shuffled } from './random'
import { firstNonZero } from './score'
import type { EngineSeason, FixedGame } from './types'

/** A game the run must place: two teams, not yet a time or a field. */
export interface Matchup {
  /** Stable within a run, e.g. `sea_a:tem_x:tem_y:2`. */
  key: string
  seasonId: string
  homeTeamId: string
  awayTeamId: string
  exhibition: boolean
}

/** How many games of each type every participant is to end up with. */
export interface Targets {
  regular: number
  exhibition: number
}

/** A team's games of each type. */
export interface TeamCounts {
  regular: number
  exhibition: number
}

/** The season's teams: its participants, then its exhibition teams. */
export function seasonTeams(season: EngineSeason): string[] {
  return [...season.participants, ...season.exhibitionTeams]
}

/** The season's fixed games, counted per team of the season by type. */
export function fixedCounts(
  season: EngineSeason,
  fixed: readonly FixedGame[]
): Map<string, TeamCounts> {
  const counts = new Map<string, TeamCounts>(
    seasonTeams(season).map(team => [team, { regular: 0, exhibition: 0 }])
  )
  for (const game of fixed) {
    if (game.seasonId !== season.id) continue
    for (const team of [game.homeTeamId, game.awayTeamId]) {
      const count = counts.get(team)
      if (count == null) continue
      if (game.exhibition) count.exhibition++
      else count.regular++
    }
  }
  return counts
}

/**
 * What each participant still needs to reach the targets: the target less its
 * fixed games of that type, never below zero. A participant left out of a
 * partial run needs nothing.
 */
export function seasonNeeds(
  season: EngineSeason,
  targets: Targets,
  counts: Map<string, TeamCounts>,
  active: ReadonlySet<string> | null
): Map<string, TeamCounts> {
  const needs = new Map<string, TeamCounts>()
  for (const team of season.participants) {
    const count = counts.get(team) ?? { regular: 0, exhibition: 0 }
    const playing = active == null || active.has(team)
    needs.set(team, {
      regular: playing ? Math.max(0, targets.regular - count.regular) : 0,
      exhibition: playing
        ? Math.max(0, targets.exhibition - count.exhibition)
        : 0
    })
  }
  return needs
}

const pairKey = (a: string, b: string): string =>
  a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`

/**
 * Regular-season pairs by greedy degree-constrained pairing: the team needing
 * the most games plays the team still needing games that it has met the
 * fewest times, ties going to the team needing more, then to the seed's
 * order. Where the greedy pass leaves a pair meeting more than `cap` times,
 * two-game swaps (a–b and c–d become a–c and b–d) repair it, keeping every
 * team's count. That keeps opponents even: every pair meets ⌊R/(n−1)⌋ or
 * ⌈R/(n−1)⌉ times.
 */
export function regularPairs(
  order: readonly string[],
  needs: Map<string, number>,
  met: Map<string, number>,
  cap: number
): Array<[string, string]> {
  const left = new Map(order.map(team => [team, needs.get(team) ?? 0]))
  const rank = new Map(order.map((team, i) => [team, i]))
  const meetings = (a: string, b: string): number => met.get(pairKey(a, b)) ?? 0
  const meet = (a: string, b: string, by: number): void => {
    met.set(pairKey(a, b), meetings(a, b) + by)
  }
  const byNeed = (a: string, b: string): number =>
    firstNonZero(
      (left.get(b) ?? 0) - (left.get(a) ?? 0),
      (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
    )
  const pairs: Array<[string, string]> = []
  for (;;) {
    const needing = order.filter(team => (left.get(team) ?? 0) > 0)
    if (needing.length < 2) break
    const [first, ...others] = [...needing].sort(byNeed)
    const [second] = others.sort((a, b) =>
      firstNonZero(meetings(first, a) - meetings(first, b), byNeed(a, b))
    )
    pairs.push([first, second])
    left.set(first, (left.get(first) ?? 0) - 1)
    left.set(second, (left.get(second) ?? 0) - 1)
    meet(first, second, 1)
  }

  for (let changed = true, rounds = 0; changed && rounds < 1000; rounds++) {
    changed = false
    for (let i = 0; i < pairs.length && !changed; i++) {
      const [a, b] = pairs[i]
      if (meetings(a, b) <= cap) continue
      for (let j = 0; j < pairs.length && !changed; j++) {
        if (j === i) continue
        const [c, d] = pairs[j]
        if (c === a || c === b || d === a || d === b) continue
        for (const [x, y] of [
          [c, d],
          [d, c]
        ])
          if (!changed && meetings(a, x) < cap && meetings(b, y) < cap) {
            meet(a, b, -1)
            meet(c, d, -1)
            meet(a, x, 1)
            meet(b, y, 1)
            pairs[i] = [a, x]
            pairs[j] = [b, y]
            changed = true
          }
      }
    }
  }
  return pairs
}

/**
 * The exhibition teams a participant plays: participant `i` meets the
 * exhibition teams `(i·E + k) mod |X|` for `k` below `E`, which spreads the
 * games evenly across them. Opponents it already has a fixed exhibition game
 * against are crossed off first, then it takes as many as it still needs.
 */
export function exhibitionOpponents(
  index: number,
  perTeam: number,
  exhibitionTeams: readonly string[],
  alreadyPlayed: readonly string[],
  need: number
): string[] {
  if (exhibitionTeams.length === 0) return []
  const assigned: string[] = []
  for (let k = 0; k < perTeam; k++)
    assigned.push(
      exhibitionTeams[(index * perTeam + k) % exhibitionTeams.length]
    )
  for (const team of alreadyPlayed) {
    const at = assigned.indexOf(team)
    if (at >= 0) assigned.splice(at, 1)
  }
  return assigned.slice(0, need)
}

/**
 * Who hosts each game, so every team hosts about as often as it visits,
 * fixed games counted. Each game first goes to the team that has hosted
 * less so far; then, while a team hosts two or more games more than it
 * visits (or the reverse), the hosting along a chain of games from it to a
 * team leaning the other way flips, which moves the surplus along without
 * changing anyone between.
 */
export function orient(
  pairs: Array<[string, string]>,
  fixed: readonly FixedGame[]
): Array<[string, string]> {
  const balance = new Map<string, number>()
  const lean = (team: string): number => balance.get(team) ?? 0
  const shift = (team: string, by: number): void => {
    balance.set(team, lean(team) + by)
  }
  for (const game of fixed) {
    shift(game.homeTeamId, 1)
    shift(game.awayTeamId, -1)
  }
  const out = pairs.map(([a, b]): [string, string] => {
    const home = lean(b) < lean(a) ? b : a
    const away = home === a ? b : a
    shift(home, 1)
    shift(away, -1)
    return [home, away]
  })

  // Flips a chain of games from `from` to the nearest team `wanted`
  // accepts: following games it hosts when `hosting`, else games it visits.
  const flipChain = (
    from: string,
    hosting: boolean,
    wanted: (lean: number) => boolean
  ): boolean => {
    // Each step of the search: a team, the game that reached it, and the
    // step it was reached from.
    const steps = [{ team: from, game: -1, back: -1 }]
    const seen = new Set([from])
    for (let at = 0; at < steps.length; at++) {
      const { team } = steps[at]
      out.forEach(([home, away], game) => {
        const next = hosting
          ? home === team
            ? away
            : null
          : away === team
            ? home
            : null
        if (next == null || seen.has(next)) return
        seen.add(next)
        steps.push({ team: next, game, back: at })
      })
      const found = steps.findIndex(
        (step, i) => i > 0 && wanted(lean(step.team))
      )
      if (found < 0) continue
      for (let i = found; i > 0; i = steps[i].back) {
        const [home, away] = out[steps[i].game]
        out[steps[i].game] = [away, home]
        shift(home, -2)
        shift(away, 2)
      }
      return true
    }
    return false
  }

  for (let guard = 0; guard < 4 * out.length + 4; guard++) {
    const teams = [...balance.keys()]
    const most = teams.reduce((a, b) => (lean(b) > lean(a) ? b : a), teams[0])
    if (lean(most) >= 2 && flipChain(most, true, value => value <= -1)) continue
    const least = teams.reduce((a, b) => (lean(b) < lean(a) ? b : a), teams[0])
    if (lean(least) <= -2 && flipChain(least, false, value => value >= 1))
      continue
    break
  }
  return out
}

/**
 * The games a season needs placed to reach the targets. Fixed games count
 * toward them, by type. Exhibition teams play only participants, and only
 * exhibition games. In a partial run, teams left out get no new games.
 */
export function buildMatchups(
  season: EngineSeason,
  targets: Targets,
  fixed: readonly FixedGame[],
  active: ReadonlySet<string> | null,
  random: Random
): Matchup[] {
  const own = fixed.filter(game => game.seasonId === season.id)
  const needs = seasonNeeds(season, targets, fixedCounts(season, own), active)
  const met = new Map<string, number>()
  const played = new Map<string, string[]>()
  for (const game of own) {
    if (!game.exhibition) {
      const key = pairKey(game.homeTeamId, game.awayTeamId)
      met.set(key, (met.get(key) ?? 0) + 1)
      continue
    }
    for (const [team, other] of [
      [game.homeTeamId, game.awayTeamId],
      [game.awayTeamId, game.homeTeamId]
    ])
      played.set(team, [...(played.get(team) ?? []), other])
  }

  const regular = regularPairs(
    shuffled(season.participants, random),
    new Map([...needs].map(([team, need]) => [team, need.regular])),
    met,
    Math.max(
      1,
      Math.ceil(targets.regular / Math.max(1, season.participants.length - 1))
    )
  )
  const exhibitionTeams = season.exhibitionTeams.filter(
    team => active == null || active.has(team)
  )
  const exhibition: Array<[string, string]> = []
  season.participants.forEach((team, i) => {
    const opponents = exhibitionOpponents(
      i,
      targets.exhibition,
      season.exhibitionTeams,
      played.get(team) ?? [],
      needs.get(team)?.exhibition ?? 0
    )
    for (const opponent of opponents)
      if (exhibitionTeams.includes(opponent)) exhibition.push([team, opponent])
  })

  const oriented = orient([...regular, ...exhibition], own)
  const seen = new Map<string, number>()
  return oriented.map(([home, away], i) => {
    const base = `${season.id}:${home}:${away}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return {
      key: `${base}:${n}`,
      seasonId: season.id,
      homeTeamId: home,
      awayTeamId: away,
      exhibition: i >= regular.length
    }
  })
}
