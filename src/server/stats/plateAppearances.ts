import type { GumboPlay } from '../../common/gumboPlay'
import type { GameTeams } from '../events/eventWrite'
import {
  type ChargedPlay,
  gameStatLines,
  HIT_TYPES,
  SAC_BUNTS,
  SAC_FLIES,
  STRIKEOUTS
} from './gumboStats'

/**
 * Each plate appearance of a game and the state it began in: the outs, the
 * runners on base and how its first pitch went. The stats builder writes
 * them beside the game's lines. They are what `gameStatLines` charged, play
 * by play, as it charged it — the batter a two-strike strikeout belongs to,
 * the pitcher an inherited walk belongs to, each pitcher's outs — so their
 * sums are the lines' figures, and they can be split in SQL.
 *
 * Outs made on a play that is no plate appearance (a runner caught
 * stealing, picked off), or charged to another pitcher than the plate
 * appearance's, are a row of their own with `isPa` false, so a pitcher's
 * outs add up as on his line.
 */
export interface PlateAppearance {
  /** False for a row that only carries outs. */
  isPa: boolean
  atBatIndex: number
  inning: number
  halfInning: 'top' | 'bottom'
  batterGumboId: number | null
  pitcherGumboId: number | null
  battingTeamId: string | null
  pitchingTeamId: string | null
  /** Null, with the runners, where the half's earlier plays are not known. */
  outsBefore: number | null
  /** Null where the runners are not known. */
  onFirst: boolean | null
  onSecond: boolean | null
  onThird: boolean | null
  /** The batter's: his plate appearance's first pitch and every pitch of it. */
  firstPitch: FirstPitch | null
  pitches: number
  /** The row's pitcher's: the first pitch if he threw it, the pitches he threw. */
  firstPitchThrown: FirstPitch | null
  pitchesThrown: number
  ab: number
  h: number
  singles: number
  doubles: number
  triples: number
  hr: number
  bb: number
  k: number
  hbp: number
  ci: number
  sf: number
  sh: number
  rbi: number
  outsMade: number
}

export type Base = '1B' | '2B' | '3B'
const BASES = new Set<unknown>(['1B', '2B', '3B'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export type FirstPitch = 'ball' | 'strike' | 'inPlay' | 'other'

/**
 * A play's pitches, in order: each one's event index, its pitcher when the
 * event names him, and how it went.
 */
function pitchesOf(
  play: GumboPlay
): Array<{ index: number; player: unknown; call: FirstPitch }> {
  const events: unknown = (play as Record<string, unknown>).playEvents
  if (!Array.isArray(events)) return []
  return events.flatMap((event: unknown, at: number) => {
    if (!isRecord(event) || event.isPitch !== true) return []
    const details = isRecord(event.details) ? event.details : {}
    const call: FirstPitch =
      details.isInPlay === true
        ? 'inPlay'
        : details.isStrike === true
          ? 'strike'
          : details.isBall === true
            ? 'ball'
            : 'other'
    return [
      {
        index: typeof event.index === 'number' ? event.index : at,
        player: event.player,
        call
      }
    ]
  })
}

/**
 * Who is on base after a play, from who was before and its runners: each
 * runner leaves the base he started the play on, and ends where his last
 * movement in the play put him, unless he was put out or scored.
 */
export function basesAfter(
  bases: Map<Base, string>,
  play: GumboPlay
): Map<Base, string> {
  if (!Array.isArray(play.runners)) return bases
  const moves = new Map<
    string,
    { start: unknown; end: unknown; out: boolean }
  >()
  play.runners.forEach((entry, index) => {
    const row: Record<string, unknown> = entry
    const movement = row.movement
    if (!isRecord(movement)) return
    const details = isRecord(row.details) ? row.details : {}
    const runner = isRecord(details.runner) ? details.runner : {}
    // A runner with neither id nor name is followed by where he went: an
    // entry starting where an earlier one of this play ended is his next.
    const anonymous = [...moves.entries()].find(
      ([key, move]) =>
        key.startsWith('entry:') && !move.out && move.end === movement.start
    )?.[0]
    const key =
      typeof runner.id === 'number'
        ? `id:${runner.id}`
        : typeof runner.fullName === 'string'
          ? `name:${runner.fullName}`
          : (anonymous ?? `entry:${index}`)
    const held = moves.get(key)
    const out = movement.isOut === true
    if (held == null)
      moves.set(key, { start: movement.start, end: movement.end, out })
    else {
      held.end = movement.end
      held.out = held.out || out
    }
  })
  const next = new Map(bases)
  for (const move of moves.values())
    if (BASES.has(move.start)) next.delete(move.start as Base)
  for (const [key, move] of moves)
    if (!move.out && BASES.has(move.end)) next.set(move.end as Base, key)
  return next
}

/**
 * Runners put on base before a play's first pitch, as the extra-innings
 * runner is: an entry that starts nowhere and is not the batter.
 */
function placedRunners(play: GumboPlay): GumboPlay {
  if (!Array.isArray(play.runners)) return { ...play, runners: [] }
  const batter: Record<string, unknown> = isRecord(play.matchup?.batter)
    ? play.matchup.batter
    : {}
  const placed = play.runners.filter(entry => {
    const row: Record<string, unknown> = entry
    if (!isRecord(row.movement) || row.movement.start != null) return false
    if (!BASES.has(row.movement.end)) return false
    const details = isRecord(row.details) ? row.details : {}
    const runner = isRecord(details.runner) ? details.runner : {}
    if (runner.id != null || batter.id != null) return runner.id !== batter.id
    return runner.fullName !== batter.fullName
  })
  return { ...play, runners: placed }
}

/**
 * Who was on base as each play's plate appearance began, by its place in
 * the list: a placed runner already on. Null for the half the recorded
 * plays begin in, when they do not begin at the game's first plate
 * appearance: who was on base then is not known, nor how many were out.
 */
function basesBefore(plays: GumboPlay[]): Array<Map<Base, string> | null> {
  const before: Array<Map<Base, string> | null> = []
  const historyKnown = plays[0]?.about.atBatIndex === 0
  const firstHalf =
    plays[0] == null
      ? null
      : `${String(plays[0].about.inning)}:${String(plays[0].about.halfInning)}`
  let half: string | null = null
  let bases = new Map<Base, string>()
  for (const play of plays) {
    const { inning, halfInning } = play.about
    const key = `${String(inning)}:${String(halfInning)}`
    if (key !== half) {
      half = key
      bases = new Map()
    }
    const placed = basesAfter(bases, placedRunners(play))
    before.push(!historyKnown && key === firstHalf ? null : placed)
    bases = basesAfter(bases, play)
  }
  return before
}

/** A game's plate appearances, and its rows of outs alone, in order. */
export function plateAppearances(
  plays: GumboPlay[],
  teams: GameTeams,
  known: ReadonlySet<number>
): PlateAppearance[] {
  const charged: ChargedPlay[] = []
  const result = gameStatLines(plays, teams, known, play => {
    charged.push(play)
  })
  // A game whose plays do not add up has no lines, and so no rows either.
  return result.kind === 'lines' ? rowsOf(plays, charged) : []
}

/**
 * The rows of plays as `gameStatLines` charged them: the builder passes what
 * the run that made the game's lines reported, so both come from one walk.
 */
export function rowsOf(
  plays: GumboPlay[],
  charges: readonly ChargedPlay[]
): PlateAppearance[] {
  const bases = basesBefore(plays)
  const out: PlateAppearance[] = []
  const row = (
    charged: ChargedPlay,
    fields: Partial<PlateAppearance>
  ): PlateAppearance => {
    const on = bases[charged.playIndex]
    return {
      isPa: false,
      atBatIndex: charged.atBatIndex,
      inning: charged.inning,
      halfInning: charged.halfInning,
      batterGumboId: null,
      pitcherGumboId: null,
      battingTeamId: charged.battingTeamId,
      pitchingTeamId: charged.pitchingTeamId,
      outsBefore: on == null ? null : charged.outsBefore,
      onFirst: on == null ? null : on.has('1B'),
      onSecond: on == null ? null : on.has('2B'),
      onThird: on == null ? null : on.has('3B'),
      firstPitch: null,
      pitches: 0,
      firstPitchThrown: null,
      pitchesThrown: 0,
      ab: 0,
      h: 0,
      singles: 0,
      doubles: 0,
      triples: 0,
      hr: 0,
      bb: 0,
      k: 0,
      hbp: 0,
      ci: 0,
      sf: 0,
      sh: 0,
      rbi: 0,
      outsMade: 0,
      ...fields
    }
  }
  for (const charged of charges) {
    const { eventType } = charged
    // A run batted in is the hitter's; when a pinch hitter struck out for
    // the batter he replaced, the plate appearance is the replaced man's and
    // the run batted in the pinch hitter's own row.
    const rbiOnRow = charged.hitterId === charged.batterId ? charged.rbi : 0
    // Each pitch is its thrower's, as on the lines: a pitcher who came or
    // went in the middle of the plate appearance has a row for the pitches
    // that were his, and so do the pitches of a play that is no plate
    // appearance, as an inning ended by a caught stealing mid-count.
    const pitches = pitchesOf(plays[charged.playIndex])
    const thrower = (pitch: {
      index: number
      player: unknown
    }): number | null => charged.pitcherAt(pitch.index, pitch.player)
    // The plate appearance's pitcher takes its outs; any other pitcher's
    // outs on the play are a row of their own.
    const own = charged.isPa
      ? charged.outs
          .filter(each => each.pitcherId === charged.pitcherId)
          .reduce((total, each) => total + each.outs, 0)
      : 0
    if (charged.isPa)
      out.push(
        row(charged, {
          isPa: true,
          batterGumboId: charged.batterId,
          pitcherGumboId: charged.pitcherId,
          firstPitch: pitches[0]?.call ?? null,
          pitches: pitches.length,
          firstPitchThrown:
            pitches[0] != null && thrower(pitches[0]) === charged.pitcherId
              ? pitches[0].call
              : null,
          pitchesThrown: pitches.filter(
            pitch => thrower(pitch) === charged.pitcherId
          ).length,
          ab: charged.isAb ? 1 : 0,
          h: HIT_TYPES.has(eventType) ? 1 : 0,
          singles: eventType === 'single' ? 1 : 0,
          doubles: eventType === 'double' ? 1 : 0,
          triples: eventType === 'triple' ? 1 : 0,
          hr: eventType === 'home_run' ? 1 : 0,
          bb: eventType === 'walk' || eventType === 'intent_walk' ? 1 : 0,
          k: STRIKEOUTS.has(eventType) ? 1 : 0,
          hbp: eventType === 'hit_by_pitch' ? 1 : 0,
          ci: eventType === 'catcher_interf' ? 1 : 0,
          sf: SAC_FLIES.has(eventType) ? 1 : 0,
          sh: SAC_BUNTS.has(eventType) ? 1 : 0,
          rbi: rbiOnRow,
          outsMade: own
        })
      )
    const others = new Map<number | null, typeof pitches>()
    for (const pitch of pitches) {
      const by = thrower(pitch)
      if (charged.isPa && by === charged.pitcherId) continue
      others.set(by, [...(others.get(by) ?? []), pitch])
    }
    for (const [pitcherId, thrown] of others)
      out.push(
        row(charged, {
          pitcherGumboId: pitcherId,
          firstPitchThrown:
            charged.isPa && thrown[0] === pitches[0] ? pitches[0].call : null,
          pitchesThrown: thrown.length
        })
      )
    if (charged.isPa && rbiOnRow !== charged.rbi)
      out.push(
        row(charged, { batterGumboId: charged.hitterId, rbi: charged.rbi })
      )
    for (const each of charged.outs)
      if (!charged.isPa || each.pitcherId !== charged.pitcherId)
        out.push(
          row(charged, { pitcherGumboId: each.pitcherId, outsMade: each.outs })
        )
  }
  return out
}
