import { Occupancy } from './feasibility'
import { type Matchup, seasonTeams } from './matchups'
import { seasonZones } from './seasonZones'
import {
  dayNumber,
  firstOpenDate,
  type GamePoint,
  LocalClock,
  MINUTE,
  seasonSlots,
  type SeasonWindow,
  type Slot,
  type Supply
} from './slots'
import type { EngineField, EngineInput, EngineSeason, FixedGame } from './types'

/**
 * A season's slots of one field on one date in one part of the day. Every
 * slot of a group scores the same, so the search compares groups and then
 * takes a group's earliest free slot, which keeps games packed.
 */
export interface SlotGroup {
  index: number
  slots: Slot[]
}

/** A fixed game of a season, with where it falls on its field's calendar. */
export interface FixedPoint {
  game: FixedGame
  point: GamePoint
}

/** What the engine knows of one season of the run. */
export interface SeasonContext {
  /** Its position in the run's seasons. */
  index: number
  season: EngineSeason
  /** Participants, then exhibition teams. */
  teams: string[]
  clock: LocalClock
  /**
   * The zone a game on a field is read in: the field's, or, for a field not
   * in the run, the zone of the season's first selected field of its required size.
   */
  zoneOf: (fieldId: string | null) => string
  bufferMs: number
  slots: Slot[]
  groups: SlotGroup[]
  windows: SeasonWindow[]
  supply: Supply
  /** The first and last day it can still get games, on any of its fields. */
  firstDay: number
  lastDay: number
  fixed: FixedPoint[]
  weeklyGames: Array<{ teamIds: string[]; point: GamePoint }>
  /** Per slot, whether the field is free before any new game is placed. */
  fieldFree: Uint8Array
  /** TeamAvailability per team and slot, before placement. Only Free has its low bit set. */
  teamFree: Map<string, Uint8Array>
}

/** The whole run, read once from the input and shared by every search. */
export interface RunContext {
  input: EngineInput
  seasons: SeasonContext[]
  seasonById: Map<string, SeasonContext>
  fieldById: Map<string, EngineField>
  /** The teams of a partial run; null in a full run. */
  active: ReadonlySet<string> | null
  /**
   * The exact matchups to place, those of the run's seasons, when the input
   * names them; null when the engine pairs teams by need.
   */
  required: Matchup[] | null
}

function groupSlots(slots: Slot[]): SlotGroup[] {
  const groups = new Map<string, SlotGroup>()
  for (const slot of slots) {
    const key = `${slot.fieldId}|${slot.date}|${slot.timeOfDay}`
    let group = groups.get(key)
    if (group == null) {
      group = { index: groups.size, slots: [] }
      groups.set(key, group)
    }
    group.slots.push(slot)
  }
  return [...groups.values()]
}

/** Reads the input into the slots, groups and starting occupancy of the run. */
export function buildContext(input: EngineInput): RunContext {
  const fieldZones = new Map(
    input.fields.map(field => [field.id, field.availability.timezone])
  )
  const clock = new LocalClock()
  const seasons = input.seasons.map((season, index): SeasonContext => {
    const { slots, windows, supply } = seasonSlots(input, season, clock)
    const zones = seasonZones(input.fields, season.settings)
    const zoneOf = (fieldId: string | null): string =>
      (fieldId == null ? undefined : fieldZones.get(fieldId)) ?? zones[0]
    return {
      index,
      season,
      teams: seasonTeams(season),
      clock,
      zoneOf,
      bufferMs: season.settings.bufferMinutes * MINUTE,
      slots,
      groups: groupSlots(slots),
      windows,
      supply,
      // The earliest of its fields' first days: today comes sooner east.
      firstDay: Math.min(
        ...zones.map(zone =>
          dayNumber(firstOpenDate(season, input.notBefore, zone))
        )
      ),
      lastDay: dayNumber(season.settings.endsOn),
      fixed: input.fixed
        .filter(game => game.seasonId === season.id)
        .map(game => ({
          game,
          point: clock.pointOf(game.start, zoneOf(game.fieldId))
        })),
      weeklyGames: (
        input.weeklyGames ??
        input.fixed.map(game => ({
          ...game,
          teamIds: [game.homeTeamId, game.awayTeamId]
        }))
      )
        .filter(game => game.seasonId === season.id)
        .map(game => ({
          teamIds: game.teamIds,
          point: clock.pointOf(game.start, zoneOf(game.fieldId))
        })),
      fieldFree: new Uint8Array(slots.length),
      teamFree: new Map()
    }
  })
  const context: RunContext = {
    input,
    seasons,
    seasonById: new Map(seasons.map(season => [season.season.id, season])),
    fieldById: new Map(input.fields.map(field => [field.id, field])),
    active: input.teamIds == null ? null : new Set(input.teamIds),
    required:
      input.required?.filter(matchup =>
        seasons.some(season => season.season.id === matchup.seasonId)
      ) ?? null
  }
  const occupancy = new Occupancy(context)
  for (const season of seasons) {
    season.slots.forEach((slot, i) => {
      season.fieldFree[i] = occupancy.fieldFits(season, slot) ? 1 : 0
    })
    // A required matchup may name a team outside the season's lists.
    const teams = new Set(season.teams)
    for (const matchup of context.required ?? [])
      if (matchup.seasonId === season.season.id) {
        teams.add(matchup.homeTeamId)
        teams.add(matchup.awayTeamId)
      }
    for (const team of teams) {
      const free = new Uint8Array(season.slots.length)
      season.slots.forEach((slot, i) => {
        free[i] = occupancy.teamAvailability(season, team, slot)
      })
      season.teamFree.set(team, free)
    }
  }
  return context
}

/** How many slots a game between the two teams could take at the start. */
export function openSlots(
  season: SeasonContext,
  homeTeamId: string,
  awayTeamId: string
): number {
  const home = season.teamFree.get(homeTeamId)
  const away = season.teamFree.get(awayTeamId)
  if (home == null || away == null) return 0
  let count = 0
  for (let i = 0; i < season.slots.length; i++)
    count += season.fieldFree[i] & home[i] & away[i]
  return count
}
