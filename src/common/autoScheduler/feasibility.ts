import type { FieldSize } from '../venues'
import type { RunContext, SeasonContext } from './context'
import { DAY, MINUTE, type Slot } from './slots'

/** Something holding a field or a team for a while. */
export interface Hold {
  id: number
  start: number
  end: number
  /** The size a field is set up as for it, when known. */
  size: FieldSize | null
  /** Its season's buffer, for the game that follows it; null outside the run. */
  bufferMs: number | null
}

const NONE: Hold[] = []

/**
 * Holds filed under every UTC day within a day of them, so the holds that
 * can touch a game are all under the day it starts. A game and the gaps
 * around it are always well under a day long.
 */
export class DayBuckets {
  private readonly days = new Map<number, Hold[]>()

  add(hold: Hold): void {
    for (let day = first(hold); day <= last(hold); day++) {
      const list = this.days.get(day)
      if (list == null) this.days.set(day, [hold])
      else list.push(hold)
    }
  }

  remove(hold: Hold): void {
    for (let day = first(hold); day <= last(hold); day++) {
      const list = this.days.get(day)
      if (list == null) continue
      const at = list.findIndex(entry => entry.id === hold.id)
      if (at >= 0) list.splice(at, 1)
    }
  }

  near(instant: number): Hold[] {
    return this.days.get(Math.floor(instant / DAY)) ?? NONE
  }
}

function first(hold: Hold): number {
  return Math.floor((hold.start - DAY) / DAY)
}

function last(hold: Hold): number {
  return Math.floor((hold.end + DAY) / DAY)
}

/** The first id of a placed game's holds; bookings and fixed games use less. */
export const PLACED_ID = 1_000_000_000

/**
 * The hard rules, as an index of what holds each field and team. A game can
 * take a slot when the field is free of bookings and games, with the next
 * game's season buffer kept between them plus the field's size switch time
 * when their sizes differ; when neither team has a booking or game
 * overlapping it; and, in a season that never plays doubleheaders, when
 * neither team already plays that day.
 */
export class Occupancy {
  private readonly fields = new Map<string, DayBuckets>()
  private readonly teams = new Map<string, DayBuckets>()
  private readonly dayCounts = new Map<string, Map<number, number>>()
  private readonly switchMs = new Map<string, number>()

  constructor(readonly context: RunContext) {
    for (const field of context.input.fields)
      this.switchMs.set(field.id, field.switchMinutes * MINUTE)
    let id = 0
    for (const booking of context.input.bookings) {
      const hold: Hold = {
        id: id++,
        start: booking.start,
        end: booking.end,
        size: booking.size,
        bufferMs: null
      }
      if (booking.fieldId != null)
        this.bucketsOf(this.fields, booking.fieldId).add(hold)
      for (const team of booking.teamIds)
        this.bucketsOf(this.teams, team).add(hold)
    }
    for (const game of context.input.fixed) {
      const season = context.seasonById.get(game.seasonId)
      const hold: Hold = {
        id: id++,
        start: game.start,
        end: game.end,
        size: game.size,
        bufferMs: season?.bufferMs ?? null
      }
      if (game.fieldId != null)
        this.bucketsOf(this.fields, game.fieldId).add(hold)
      for (const team of [game.homeTeamId, game.awayTeamId])
        this.bucketsOf(this.teams, team).add(hold)
      if (season != null) {
        const day = season.clock.pointOf(game.start).day
        this.count(season, game.homeTeamId, day, 1)
        this.count(season, game.awayTeamId, day, 1)
      }
    }
  }

  private bucketsOf(map: Map<string, DayBuckets>, key: string): DayBuckets {
    let buckets = map.get(key)
    if (buckets == null) {
      buckets = new DayBuckets()
      map.set(key, buckets)
    }
    return buckets
  }

  private count(
    season: SeasonContext,
    team: string,
    day: number,
    by: number
  ): void {
    let days = this.dayCounts.get(team)
    if (days == null) {
      days = new Map()
      this.dayCounts.set(team, days)
    }
    const key = season.index * 1_000_000 + day
    days.set(key, (days.get(key) ?? 0) + by)
  }

  /** The team's games that day in the season, fixed and placed. */
  gamesOn(season: SeasonContext, team: string, day: number): number {
    return this.dayCounts.get(team)?.get(season.index * 1_000_000 + day) ?? 0
  }

  /** Whether the field is free for the slot, buffers and switch time kept. */
  fieldFits(season: SeasonContext, slot: Slot): boolean {
    const buckets = this.fields.get(slot.fieldId)
    if (buckets == null) return true
    const switchMs = this.switchMs.get(slot.fieldId) ?? 0
    for (const hold of buckets.near(slot.start)) {
      const switching =
        hold.size != null && hold.size !== slot.size ? switchMs : 0
      const before = season.bufferMs + switching
      const after = (hold.bufferMs ?? season.bufferMs) + switching
      if (hold.start < slot.end + after && slot.start < hold.end + before)
        return false
    }
    return true
  }

  /** Whether the team is free for the slot, and not already playing that day in a never season. */
  teamFits(season: SeasonContext, team: string, slot: Slot): boolean {
    const buckets = this.teams.get(team)
    if (buckets != null)
      for (const hold of buckets.near(slot.start))
        if (hold.start < slot.end && slot.start < hold.end) return false
    return (
      season.season.settings.doubleheaders !== 'never' ||
      this.gamesOn(season, team, slot.day) === 0
    )
  }

  /** Whether a game between the two teams can take the slot. */
  fits(
    season: SeasonContext,
    homeTeamId: string,
    awayTeamId: string,
    slot: Slot
  ): boolean {
    return (
      this.fieldFits(season, slot) &&
      this.teamFits(season, homeTeamId, slot) &&
      this.teamFits(season, awayTeamId, slot)
    )
  }

  private holdOf(id: number, season: SeasonContext, slot: Slot): Hold {
    return {
      id: PLACED_ID + id,
      start: slot.start,
      end: slot.end,
      size: slot.size,
      bufferMs: season.bufferMs
    }
  }

  /** Records a placed game; `id` is its index among the run's games. */
  place(
    id: number,
    season: SeasonContext,
    homeTeamId: string,
    awayTeamId: string,
    slot: Slot
  ): void {
    const hold = this.holdOf(id, season, slot)
    this.bucketsOf(this.fields, slot.fieldId).add(hold)
    this.bucketsOf(this.teams, homeTeamId).add(hold)
    this.bucketsOf(this.teams, awayTeamId).add(hold)
    this.count(season, homeTeamId, slot.day, 1)
    this.count(season, awayTeamId, slot.day, 1)
  }

  /** Takes a placed game back out. */
  unplace(
    id: number,
    season: SeasonContext,
    homeTeamId: string,
    awayTeamId: string,
    slot: Slot
  ): void {
    const hold = this.holdOf(id, season, slot)
    this.bucketsOf(this.fields, slot.fieldId).remove(hold)
    this.bucketsOf(this.teams, homeTeamId).remove(hold)
    this.bucketsOf(this.teams, awayTeamId).remove(hold)
    this.count(season, homeTeamId, slot.day, -1)
    this.count(season, awayTeamId, slot.day, -1)
  }
}
