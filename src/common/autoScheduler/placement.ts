import {
  openSlots,
  type RunContext,
  type SeasonContext,
  type SlotGroup
} from './context'
import { Occupancy } from './feasibility'
import type { Matchup } from './matchups'
import { mulberry32, type Random, randomIndex, shuffled } from './random'
import {
  addScores,
  compareScores,
  firstNonZero,
  SeasonLedger,
  TERMS,
  TRUE_ORDER
} from './score'
import type { Slot } from './slots'

/** One search's schedule: where each matchup went, or null if it didn't fit. */
export interface Placement {
  matchups: Matchup[]
  slots: Array<Slot | null>
  /** The score by the true ranking, summed over the seasons. */
  score: number[]
  ledgers: Map<string, SeasonLedger>
}

/** The local search's iteration budget for this many games. */
export function searchBudget(games: number): number {
  return Math.min(20_000, 400 * games)
}

interface Game {
  matchup: Matchup
  season: SeasonContext
  ledger: SeasonLedger
  /** The placed games of its season. */
  placed: Pool
  slot: Slot | null
}

/** A list that adds, removes and picks at random in constant time. */
class Pool {
  readonly items: number[] = []
  private readonly at = new Map<number, number>()

  add(item: number): void {
    this.at.set(item, this.items.length)
    this.items.push(item)
  }

  remove(item: number): void {
    const at = this.at.get(item)
    if (at == null) return
    const last = this.items[this.items.length - 1]
    this.items.pop()
    if (last !== item) {
      this.items[at] = last
      this.at.set(last, at)
    }
    this.at.delete(item)
  }

  pick(random: Random): number {
    return this.items[randomIndex(random, this.items.length)]
  }
}

/** The search's state: the games, what holds each field and team, and the scores. */
class Search {
  readonly games: Game[]
  readonly occupancy: Occupancy
  readonly ledgers = new Map<string, SeasonLedger>()
  readonly unplaced = new Pool()
  readonly anyPlaced = new Pool()

  constructor(
    readonly context: RunContext,
    matchups: Matchup[],
    readonly order: readonly number[]
  ) {
    this.occupancy = new Occupancy(context)
    const bySeason = new Map<
      string,
      { season: SeasonContext; ledger: SeasonLedger; placed: Pool }
    >()
    for (const season of context.seasons) {
      const planned = new Map<string, number>()
      const bump = (team: string): void => {
        planned.set(team, (planned.get(team) ?? 0) + 1)
      }
      for (const { game, point } of season.fixed)
        if (point.day >= season.firstDay && point.day <= season.lastDay) {
          bump(game.homeTeamId)
          bump(game.awayTeamId)
        }
      let count = 0
      for (const matchup of matchups)
        if (matchup.seasonId === season.season.id) {
          bump(matchup.homeTeamId)
          bump(matchup.awayTeamId)
          count++
        }
      const ledger = new SeasonLedger(season, count, planned)
      this.ledgers.set(season.season.id, ledger)
      bySeason.set(season.season.id, { season, ledger, placed: new Pool() })
    }
    this.games = matchups.map((matchup, i) => {
      const of = bySeason.get(matchup.seasonId)
      if (of == null)
        throw new Error(`No season ${matchup.seasonId} in the run`)
      this.unplaced.add(i)
      return { matchup, ...of, slot: null }
    })
  }

  put(i: number, slot: Slot): void {
    const game = this.games[i]
    const { homeTeamId, awayTeamId } = game.matchup
    this.occupancy.place(i, game.season, homeTeamId, awayTeamId, slot)
    game.ledger.add(homeTeamId, awayTeamId, slot, slot.scarcity)
    game.slot = slot
    this.unplaced.remove(i)
    game.placed.add(i)
    this.anyPlaced.add(i)
  }

  take(i: number): Slot {
    const game = this.games[i]
    const slot = game.slot
    if (slot == null) throw new Error(`${game.matchup.key} has no slot`)
    const { homeTeamId, awayTeamId } = game.matchup
    this.occupancy.unplace(i, game.season, homeTeamId, awayTeamId, slot)
    game.ledger.remove(homeTeamId, awayTeamId, slot, slot.scarcity)
    game.slot = null
    game.placed.remove(i)
    this.anyPlaced.remove(i)
    this.unplaced.add(i)
    return slot
  }

  /**
   * The group's earliest slot the game can take now, trying first the
   * starts that pack the field's open time without gaps.
   */
  earliestIn(i: number, group: SlotGroup): Slot | null {
    const game = this.games[i]
    const { homeTeamId, awayTeamId } = game.matchup
    for (const onGrid of [true, false])
      for (const slot of group.slots)
        if (
          slot.onGrid === onGrid &&
          this.occupancy.fits(game.season, homeTeamId, awayTeamId, slot)
        )
          return slot
    return null
  }

  /**
   * Places a game greedily: into the best-scoring group with a free slot,
   * ties going to the order `rank` gives the season's groups.
   */
  placeGreedily(i: number, rank: Map<string, number[]>): void {
    const game = this.games[i]
    const { ledger } = game
    const { homeTeamId, awayTeamId } = game.matchup
    // Groups on the same day and part of the day score the same unless
    // their fields differ in scarcity, so each is scored once.
    const scored = new Map<string, number[]>()
    const costs = game.season.groups.map(group => {
      const slot = group.slots[0]
      const key = `${slot.day}|${slot.timeOfDay}|${slot.scarcity}`
      let score = scored.get(key)
      if (score == null) {
        ledger.add(homeTeamId, awayTeamId, slot, slot.scarcity)
        score = ledger.score()
        ledger.remove(homeTeamId, awayTeamId, slot, slot.scarcity)
        scored.set(key, score)
      }
      return score
    })
    const tieBreak = rank.get(game.matchup.seasonId) ?? []
    const ranked = game.season.groups
      .map(group => group.index)
      .sort((a, b) =>
        firstNonZero(
          compareScores(costs[a], costs[b], this.order),
          tieBreak[a] - tieBreak[b]
        )
      )
    for (const index of ranked) {
      const slot = this.earliestIn(i, game.season.groups[index])
      if (slot != null) {
        this.put(i, slot)
        return
      }
    }
  }

  /** Tries to place a game that has no slot yet into a random group. */
  tryPlacing(random: Random): void {
    const i = this.unplaced.pick(random)
    const groups = this.games[i].season.groups
    if (groups.length === 0) return
    const slot = this.earliestIn(i, groups[randomIndex(random, groups.length)])
    if (slot != null) this.put(i, slot)
  }

  /** Moves a placed game to a random group, keeping the move unless it scores worse. */
  tryMoving(random: Random, i: number): void {
    const game = this.games[i]
    const { ledger } = game
    const before = ledger.score()
    const from = this.take(i)
    const groups = game.season.groups
    const slot = this.earliestIn(i, groups[randomIndex(random, groups.length)])
    if (slot != null && slot !== from) {
      this.put(i, slot)
      if (compareScores(ledger.score(), before, this.order) <= 0) return
      this.take(i)
    }
    this.put(i, from)
  }

  /** Swaps two placed games of a season, keeping the swap unless it scores worse. */
  trySwapping(random: Random, i: number): void {
    const game = this.games[i]
    const j = game.placed.pick(random)
    if (j === i) return
    const { ledger } = game
    const before = ledger.score()
    const mine = this.take(i)
    const theirs = this.take(j)
    const fits = (k: number, slot: Slot): boolean => {
      const { homeTeamId, awayTeamId } = this.games[k].matchup
      return this.occupancy.fits(
        this.games[k].season,
        homeTeamId,
        awayTeamId,
        slot
      )
    }
    if (fits(i, theirs)) {
      this.put(i, theirs)
      if (fits(j, mine)) {
        this.put(j, mine)
        if (compareScores(ledger.score(), before, this.order) <= 0) return
        this.take(j)
      }
      this.take(i)
    }
    this.put(i, mine)
    this.put(j, theirs)
  }

  /** The score by the true ranking, summed over the seasons. */
  total(): number[] {
    let total = new Array<number>(TERMS).fill(0)
    for (const ledger of this.ledgers.values())
      total = addScores(total, ledger.score())
    return total
  }
}

/**
 * Places the matchups. A greedy pass takes the most constrained first (the
 * fewest open slots at the start), each into the lowest-cost slot; then a
 * local search seeded from `seed` moves one game or swaps two under
 * `order`, for `budget` iterations. It never keeps a change that scores
 * worse, but keeps one that scores the same: the spacing term moves in
 * whole steps, and walking across equal scores is how the search reaches
 * the next step down.
 */
export function place(
  context: RunContext,
  matchups: Matchup[],
  seed: number,
  order: readonly number[] = TRUE_ORDER,
  budget = searchBudget(matchups.length)
): Placement {
  const search = new Search(context, matchups, order)
  const open = search.games.map(game =>
    openSlots(game.season, game.matchup.homeTeamId, game.matchup.awayTeamId)
  )
  const greedy = search.games
    .map((_, i) => i)
    .sort((a, b) => firstNonZero(open[a] - open[b], a - b))
  // Equal-cost groups are taken in an order the seed shuffles, so games
  // spread across a slice of the season rather than all on its first day.
  const random = mulberry32(seed)
  const rank = new Map(
    context.seasons.map(season => {
      const order = new Array<number>(season.groups.length)
      shuffled(
        season.groups.map(group => group.index),
        random
      ).forEach((group, i) => {
        order[group] = i
      })
      return [season.season.id, order]
    })
  )
  for (const i of greedy) if (open[i] > 0) search.placeGreedily(i, rank)

  for (let step = 0; step < budget; step++) {
    const roll = random()
    if (search.unplaced.items.length > 0 && roll < 0.2) {
      search.tryPlacing(random)
      continue
    }
    if (search.anyPlaced.items.length === 0) break
    const i = search.anyPlaced.pick(random)
    if (roll < 0.7) search.tryMoving(random, i)
    else search.trySwapping(random, i)
  }

  return {
    matchups,
    slots: search.games.map(game => game.slot),
    score: search.total(),
    ledgers: search.ledgers
  }
}
