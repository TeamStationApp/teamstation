import { compactEvents, type StreamEvent } from './eventStream'

export type { StreamEvent }

/**
 * Where a game stands, event by event: the count, the outs, the inning, who is
 * at the plate, who is on the mound, and who is standing on which base.
 *
 * Four engines — situation, lineup, fielders, baserunners — and the reason they
 * exist is that everything we worked out above them was inferred from somewhere
 * else. The inning came from the play-by-play's own labels, which sometimes
 * disagree with the stream; the plate appearances came from counting balls and
 * strikes, which missed 48 of 4,634; the batter came from the first name in a
 * sentence. All four are decided here instead, from the stream.
 *
 * Each engine reads the others' state as it stood *before* the event being
 * applied. That is the whole reason this file is shaped the way it is: one walk
 * over the events hands a visitor everything it may read before any of the four
 * moves, and only then do they move. Getting that order wrong is not a detail —
 * the earned-run rule asks who was pitching before the substitution and where a
 * runner stood before the throw.
 *
 * Only what the scoring needs is here. Designated hitters and the DP/flex pair
 * are left out, and the events that drive only those are ignored rather than
 * half-handled.
 */

/** Attributes come off the wire as `unknown`; these are the only two shapes. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function count(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/** What each kind of ball in play does. */
export interface BallInPlayConfig {
  bases: number
  batterOut: boolean
  error: boolean
}

export const BALL_IN_PLAY: Record<string, BallInPlayConfig> = {
  single: { bases: 1, batterOut: false, error: false },
  double: { bases: 2, batterOut: false, error: false },
  triple: { bases: 3, batterOut: false, error: false },
  home_run: { bases: 4, batterOut: false, error: false },
  dropped_third_strike: { bases: 1, batterOut: false, error: false },
  dropped_third_strike_batter_out: { bases: 1, batterOut: true, error: false },
  fielders_choice: { bases: 1, batterOut: false, error: false },
  error: { bases: 1, batterOut: false, error: true },
  sacrifice_bunt: { bases: 1, batterOut: false, error: false },
  sacrifice_fly: { bases: 1, batterOut: true, error: false },
  sacrifice_bunt_error: { bases: 1, batterOut: false, error: true },
  sacrifice_fly_error: { bases: 1, batterOut: false, error: true },
  batter_out: { bases: 0, batterOut: true, error: false },
  batter_out_advance_runners: { bases: 1, batterOut: true, error: false },
  offensive_interference: { bases: 0, batterOut: true, error: false },
  infield_fly: { bases: 0, batterOut: true, error: false },
  other_out: { bases: 0, batterOut: true, error: false },
  foul_tip_out: { bases: 0, batterOut: true, error: false }
}

/** And what each kind of base running is. */
export interface BaseRunningConfig {
  runnerOut: boolean
  error: boolean
}

export const BASE_RUNNING: Record<string, BaseRunningConfig> = {
  offensive_interference: { runnerOut: true, error: false },
  stole_base: { runnerOut: false, error: false },
  defensive_indifference: { runnerOut: false, error: false },
  passed_ball: { runnerOut: false, error: false },
  on_same_pitch: { runnerOut: false, error: false },
  wild_pitch: { runnerOut: false, error: false },
  attempted_pickoff: { runnerOut: false, error: false },
  fielders_choice_attempted_pickoff: { runnerOut: false, error: false },
  advanced_on_error: { runnerOut: false, error: true },
  on_same_error: { runnerOut: false, error: false },
  out_on_appeal: { runnerOut: true, error: false },
  caught_stealing: { runnerOut: true, error: false },
  other_out: { runnerOut: true, error: false },
  other_advance: { runnerOut: false, error: false },
  picked_off: { runnerOut: true, error: false },
  did_not_score: { runnerOut: false, error: false },
  advanced_on_last_play: { runnerOut: false, error: false },
  remained_on_last_play: { runnerOut: false, error: false },
  out_on_last_play: { runnerOut: true, error: false }
}

export function ballInPlayConfig(playResult: unknown): BallInPlayConfig {
  return (
    BALL_IN_PLAY[String(playResult)] ?? {
      bases: 0,
      batterOut: true,
      error: false
    }
  )
}

export function baseRunningConfig(playType: unknown): BaseRunningConfig {
  return BASE_RUNNING[String(playType)] ?? { runnerOut: false, error: false }
}

/**
 * A position anybody may hold at once — which is to say, not a position on the
 * field. `EH` is an extra hitter and `DH` a designated one, and neither is
 * somewhere a ball can be thrown.
 */
const MULTI_POSITION = new Set([undefined, 'EH', 'DH'])
const DEFAULT_POSITION = 'EH'

function isUniquePosition(position: string | undefined): boolean {
  return !MULTI_POSITION.has(position)
}

/** What this one event did, and nothing else. */
export interface EventFlags {
  wasOut: boolean
  endedInning: boolean
  strikeout: boolean
  walk: boolean
}

/** The situation as it stood at one moment, copied so it cannot move. */
export interface SituationSnapshot {
  balls: number
  strikes: number
  outs: number
  inning: number
  half: 'top' | 'bottom'
  homeId: string
  awayId: string
  atBatTeamId: string
  inFieldTeamId: string
  pitchesThisAtBat: number
  lastEvent: EventFlags
}

class SituationEngine {
  balls = 0
  strikes = 0
  outs = 0
  inning = 1
  half: 'top' | 'bottom' = 'top'
  homeId = ''
  awayId = ''
  pitchesThisInning = 0
  pitchesThisAtBat = 0
  lastEvent: EventFlags = {
    wasOut: false,
    endedInning: false,
    strikeout: false,
    walk: false
  }

  get atBatTeamId(): string {
    return this.half === 'top' ? this.awayId : this.homeId
  }

  get inFieldTeamId(): string {
    return this.half === 'top' ? this.homeId : this.awayId
  }

  snapshot(): SituationSnapshot {
    return {
      balls: this.balls,
      strikes: this.strikes,
      outs: this.outs,
      inning: this.inning,
      half: this.half,
      homeId: this.homeId,
      awayId: this.awayId,
      atBatTeamId: this.atBatTeamId,
      inFieldTeamId: this.inFieldTeamId,
      pitchesThisAtBat: this.pitchesThisAtBat,
      lastEvent: { ...this.lastEvent }
    }
  }

  apply(event: StreamEvent): void {
    this.lastEvent = {
      wasOut: false,
      endedInning: false,
      strikeout: false,
      walk: false
    }
    const a = event.attributes ?? {}

    switch (event.code) {
      case 'set_teams':
        this.homeId = text(a.homeId)
        this.awayId = text(a.awayId)
        return

      case 'pitch':
        this.pitch(a)
        break

      case 'ball_in_play': {
        this.pitchesThisAtBat = 0
        this.strikes = 0
        this.balls = 0
        const result = text(a.playResult)
        if (ballInPlayConfig(result).batterOut) {
          this.outs += 1
          this.lastEvent.wasOut = true
        }
        if (result.startsWith('dropped_third_strike')) {
          this.lastEvent.strikeout = true
        }
        break
      }

      case 'foul_error':
        if (a.advancesCount === true)
          this.strikes = Math.min(this.strikes + 1, 2)
        break

      case 'base_running':
        if (baseRunningConfig(a.playType).runnerOut) {
          this.outs += 1
          this.lastEvent.wasOut = true
        }
        break

      case 'end_half':
        this.pitchesThisInning = 0
        this.pitchesThisAtBat = 0
        this.lastEvent.endedInning = true
        this.outs = 0
        this.strikes = 0
        this.balls = 0
        this.turnOver()
        break

      case 'override':
        this.override(a)
        break

      case 'end_at_bat':
        this.pitchesThisAtBat = 0
        this.balls = 0
        this.strikes = 0
        if (a.reason === 'walk') this.lastEvent.walk = true
        else if (a.reason === 'strikeout') {
          this.outs += 1
          this.lastEvent.strikeout = true
          this.lastEvent.wasOut = true
        }
        break

      case 'illegal_pitch_advance':
        if (a.advancesCount === true) this.balls += 1
        break

      default:
        break
    }

    this.reconcile()
  }

  private pitch(a: Record<string, unknown>): void {
    this.pitchesThisInning += 1
    this.pitchesThisAtBat += 1
    const advances = a.advancesCount !== false
    switch (text(a.result)) {
      case 'ball':
      case 'intentional_ball':
      case 'illegal_pitch':
        if (advances) this.balls += 1
        return
      case 'strike_swinging':
      case 'strike_looking':
      case 'foul_bunt':
      case 'foul_tip':
        if (advances) this.strikes += 1
        return
      case 'foul':
        if (this.strikes !== 2 && advances) this.strikes += 1
        return
      case 'ball_in_play':
        this.balls = 0
        this.strikes = 0
        break

      default:
        break
    }
  }

  private override(a: Record<string, unknown>): void {
    if (a.inning !== undefined || a.half !== undefined) {
      this.lastEvent.endedInning = true
      this.pitchesThisInning = 0
      this.pitchesThisAtBat = 0
    }
    if (typeof a.inning === 'number') this.inning = a.inning
    if (a.half === 'top' || a.half === 'bottom') this.half = a.half
    if (typeof a.outs === 'number') this.outs = a.outs
    if (typeof a.balls === 'number') this.balls = a.balls
    if (typeof a.strikes === 'number') this.strikes = a.strikes
  }

  /**
   * Four balls, three strikes and three outs are resolved *after* the event
   * rather than by whoever raised the count, which is how a walk can come out
   * of a pitch that nobody said was a walk.
   */
  private reconcile(): void {
    if (this.balls >= 4) {
      this.strikes = 0
      this.balls = 0
      this.pitchesThisAtBat = 0
      this.lastEvent.walk = true
    }
    if (this.strikes >= 3) {
      this.strikes = 0
      this.balls = 0
      this.outs += 1
      this.pitchesThisAtBat = 0
      this.lastEvent.strikeout = true
      this.lastEvent.wasOut = true
    }
    if (this.outs >= 3) {
      this.outs = 0
      this.strikes = 0
      this.balls = 0
      this.pitchesThisAtBat = 0
      this.pitchesThisInning = 0
      this.lastEvent.endedInning = true
      this.turnOver()
    }
  }

  private turnOver(): void {
    if (this.half === 'top') this.half = 'bottom'
    else {
      this.half = 'top'
      this.inning += 1
    }
  }
}

/**
 * The batting order, and whose turn it is.
 *
 * A slot can be empty, a substitution puts somebody into the outgoing player's
 * slot rather than at the end, and the index can run **off the end** — which is
 * not a bug but the stream's end-of-lineup confirmation: until somebody says
 * the order really does wrap, there is no current batter at all.
 */
interface TeamLineup {
  batters: Array<string | undefined>
  currentIndex: number | undefined
  confirmedEndOfLineup: boolean
  temporaryBatterId: string | undefined
  advanceAfterTemporaryBatter: boolean
}

class LineupEngine {
  private readonly teams = new Map<string, TeamLineup>()

  private team(teamId: string): TeamLineup {
    const held = this.teams.get(teamId)
    if (held != null) return held
    const made: TeamLineup = {
      batters: [],
      currentIndex: 0,
      confirmedEndOfLineup: false,
      temporaryBatterId: undefined,
      advanceAfterTemporaryBatter: true
    }
    this.teams.set(teamId, made)
    return made
  }

  currentBatter(teamId: string): string | undefined {
    const team = this.team(teamId)
    if (team.temporaryBatterId !== undefined) return team.temporaryBatterId
    if (team.currentIndex === undefined) return undefined
    return team.batters[team.currentIndex]
  }

  private ensureLength(team: TeamLineup, length: number): void {
    while (team.batters.length < length) team.batters.push(undefined)
  }

  private indexOfPlayer(
    team: TeamLineup,
    playerId: string
  ): number | undefined {
    const at = team.batters.indexOf(playerId)
    return at === -1 ? undefined : at
  }

  private fillIndex(
    team: TeamLineup,
    playerId: string | undefined,
    index: number
  ): void {
    this.ensureLength(team, index)
    team.batters[index] = playerId
  }

  apply(
    event: StreamEvent,
    before: SituationSnapshot,
    after: SituationSnapshot
  ): void {
    const a = event.attributes ?? {}
    const teamId = text(a.teamId)

    switch (event.code) {
      case 'set_teams':
        this.team(text(a.homeId))
        this.team(text(a.awayId))
        return

      case 'fill_lineup': {
        const team = this.team(teamId)
        const empty = team.batters.findIndex(slot => slot === undefined)
        const playerId = text(a.playerId)
        if (empty === -1) team.batters.push(playerId)
        else team.batters[empty] = playerId
        return
      }

      case 'fill_lineup_index':
        this.fillIndex(this.team(teamId), text(a.playerId), count(a.index))
        return

      case 'reorder_lineup': {
        const team = this.team(teamId)
        const from = count(a.fromIndex)
        const to = count(a.toIndex)
        this.ensureLength(team, Math.max(from, to))
        const [moved] = team.batters.splice(from, 1)
        team.batters.splice(to, 0, moved)
        return
      }

      case 'goto_lineup_index': {
        const team = this.team(teamId)
        const index = count(a.index)
        this.ensureLength(team, index)
        team.currentIndex = index
        return
      }

      case 'clear_lineup_index': {
        const team = this.team(teamId)
        const index = count(a.index)
        if (team.batters.length > index) team.batters[index] = undefined
        return
      }

      case 'clear_entire_lineup': {
        const team = this.team(teamId)
        team.batters = []
        team.currentIndex = 0
        return
      }

      case 'squash_lineup_index': {
        const team = this.team(teamId)
        const index = count(a.index)
        if (team.batters.length <= index) return
        const modulo = team.batters.length - 1
        const current = team.currentIndex
        if (modulo === 0 || current === undefined) team.currentIndex = 0
        else {
          team.currentIndex = (current - (index < current ? 1 : 0)) % modulo
        }
        team.batters.splice(index, 1)
        return
      }

      case 'swap_players': {
        const team = this.team(teamId)
        const first = text(a.firstPlayerId)
        const second = text(a.secondPlayerId)
        const firstSlot = this.indexOfPlayer(team, first)
        const secondSlot = this.indexOfPlayer(team, second)
        if (firstSlot !== undefined) this.fillIndex(team, second, firstSlot)
        if (secondSlot !== undefined) this.fillIndex(team, first, secondSlot)
        return
      }

      case 'sub_players': {
        const team = this.team(teamId)
        const incoming = text(a.incomingPlayerId)
        const outgoing = text(a.outgoingPlayerId)
        const outgoingSlot = this.indexOfPlayer(team, outgoing)
        if (outgoingSlot === undefined) return
        const incomingSlot = this.indexOfPlayer(team, incoming)
        if (incomingSlot !== undefined) {
          this.fillIndex(team, undefined, incomingSlot)
        }
        this.fillIndex(team, incoming, outgoingSlot)
        return
      }

      case 'end_at_bat':
      case 'ball_in_play':
      case 'place_batter':
        this.increment(before.atBatTeamId)
        return

      case 'pitch':
        if (after.lastEvent.strikeout || after.lastEvent.walk) {
          this.increment(before.atBatTeamId)
        }
        return

      case 'illegal_pitch_advance':
        if (after.lastEvent.walk) this.increment(before.atBatTeamId)
        return

      case 'confirm_end_of_lineup':
        this.team(teamId).confirmedEndOfLineup = true
        return

      case 'courtesy_batter':
        this.setTemporaryBatter(teamId, text(a.incomingPlayerId), false)
        return

      case 'replace_batter':
        this.setTemporaryBatter(teamId, text(a.incomingPlayerId), true)
        return

      default:
        if (after.lastEvent.endedInning) {
          const team = this.team(before.atBatTeamId)
          team.temporaryBatterId = undefined
          team.advanceAfterTemporaryBatter = true
        }
    }
  }

  private setTemporaryBatter(
    teamId: string,
    playerId: string,
    advanceAfter: boolean
  ): void {
    const team = this.team(teamId)
    team.temporaryBatterId = playerId
    team.advanceAfterTemporaryBatter = advanceAfter
  }

  /**
   * On to the next batter — unless the order has just reached its end and
   * nobody has confirmed that it wraps, in which case there is no batter until
   * somebody says which slot to go to.
   */
  private increment(teamId: string): void {
    const team = this.team(teamId)
    const hadTemporary = team.temporaryBatterId !== undefined
    const advance = !hadTemporary || team.advanceAfterTemporaryBatter
    team.temporaryBatterId = undefined
    team.advanceAfterTemporaryBatter = true
    if (!advance) return
    this.ensureLength(team, 1)
    if (team.currentIndex === undefined) return
    const count = team.batters.length
    if (!team.confirmedEndOfLineup && team.currentIndex + 1 === count) {
      team.currentIndex = undefined
      return
    }
    team.currentIndex = (team.currentIndex + 1) % count
  }
}

class FieldersEngine {
  private readonly positions = new Map<
    string,
    Map<string, string | undefined>
  >()

  private readonly players = new Map<string, Map<string, string | undefined>>()

  private positionsOf(teamId: string): Map<string, string | undefined> {
    const held = this.positions.get(teamId)
    if (held != null) return held
    const made = new Map<string, string | undefined>()
    this.positions.set(teamId, made)
    return made
  }

  private playersOf(teamId: string): Map<string, string | undefined> {
    const held = this.players.get(teamId)
    if (held != null) return held
    const made = new Map<string, string | undefined>()
    this.players.set(teamId, made)
    return made
  }

  playerForPosition(teamId: string, position: string): string | undefined {
    return this.positionsOf(teamId).get(position)
  }

  private positionForPlayer(playerId: string, teamId: string): string {
    return this.playersOf(teamId).get(playerId) ?? DEFAULT_POSITION
  }

  apply(event: StreamEvent, before: SituationSnapshot): void {
    const a = event.attributes ?? {}
    const teamId = text(a.teamId)

    switch (event.code) {
      case 'set_teams':
        this.positionsOf(text(a.homeId))
        this.positionsOf(text(a.awayId))
        return

      case 'fill_position': {
        const playerId = text(a.playerId)
        const position = a.position === undefined ? undefined : text(a.position)
        const previous = this.positionForPlayer(playerId, teamId)
        if (isUniquePosition(previous)) {
          this.positionsOf(teamId).set(previous, undefined)
        }
        if (!isUniquePosition(position)) {
          this.playersOf(teamId).set(playerId, position ?? DEFAULT_POSITION)
          return
        }
        const displaced = this.playerForPosition(teamId, position!)
        if (displaced !== undefined) {
          this.playersOf(teamId).set(displaced, DEFAULT_POSITION)
        }
        this.playersOf(teamId).set(playerId, position)
        this.positionsOf(teamId).set(position!, playerId)
        return
      }

      case 'clear_position_by_id':
        this.clearPlayer(teamId, text(a.playerId))
        return

      case 'swap_players': {
        const first = text(a.firstPlayerId)
        const second = text(a.secondPlayerId)
        this.ensurePlayer(teamId, first)
        this.ensurePlayer(teamId, second)
        const firstPosition = this.positionForPlayer(first, teamId)
        const secondPosition = this.positionForPlayer(second, teamId)
        this.playersOf(teamId).set(first, secondPosition)
        this.playersOf(teamId).set(second, firstPosition)
        if (isUniquePosition(firstPosition)) {
          this.positionsOf(teamId).set(firstPosition, second)
        }
        if (isUniquePosition(secondPosition)) {
          this.positionsOf(teamId).set(secondPosition, first)
        }
        return
      }

      case 'sub_players': {
        const incoming = text(a.incomingPlayerId)
        const outgoing = text(a.outgoingPlayerId)
        this.ensurePlayer(teamId, incoming)
        const incomingPosition = this.positionForPlayer(incoming, teamId)
        const outgoingPosition = this.positionForPlayer(outgoing, teamId)
        if (isUniquePosition(incomingPosition)) {
          this.positionsOf(teamId).set(incomingPosition, undefined)
        }
        if (isUniquePosition(outgoingPosition)) {
          this.positionsOf(teamId).set(outgoingPosition, incoming)
        }
        this.playersOf(teamId).set(incoming, outgoingPosition)
        this.playersOf(teamId).set(outgoing, DEFAULT_POSITION)
        return
      }

      case 'clear_all_positions': {
        this.positions.set(teamId, new Map())
        const players = this.playersOf(teamId)
        for (const playerId of [...players.keys()]) {
          players.set(playerId, DEFAULT_POSITION)
        }
        return
      }

      case 'fill_lineup':
      case 'fill_lineup_index':
        this.ensurePlayer(teamId, text(a.playerId))
        return

      case 'replace_runner':
        this.ensurePlayer(teamId, text(a.incomingPlayerId))
        return

      case 'place_runner':
        this.ensurePlayer(before.atBatTeamId, text(a.runnerId))
        break

      default:
        break
    }
  }

  private ensurePlayer(teamId: string, playerId: string): void {
    const players = this.playersOf(teamId)
    if (!players.has(playerId)) players.set(playerId, DEFAULT_POSITION)
  }

  private clearPlayer(teamId: string, playerId: string): void {
    const previous = this.positionForPlayer(playerId, teamId)
    this.playersOf(teamId).set(playerId, DEFAULT_POSITION)
    if (isUniquePosition(previous)) {
      this.positionsOf(teamId).set(previous, undefined)
    }
  }
}

/**
 * Who is standing where.
 *
 * Bases 1, 2 and 3 are the obvious ones. **-3 and -2 are runners sent back**,
 * which is how the stream holds a runner who was ruled to have left too early:
 * they stand behind the base until the one in front of them is clear.
 */
class BaserunnerEngine {
  private bases = new Map<number, string | undefined>()
  scoredOnLastEvent: string[] = []
  unscoredOnLastEvent: string[] = []

  playerAtBase(base: number): string | undefined {
    return this.bases.get(base)
  }

  baseForPlayer(playerId: string): number | undefined {
    for (const base of [1, 2, 3, -3, -2]) {
      if (this.bases.get(base) === playerId) return base
    }
    return undefined
  }

  snapshot(): Map<number, string | undefined> {
    return new Map(this.bases)
  }

  apply(
    event: StreamEvent,
    before: SituationSnapshot,
    after: SituationSnapshot,
    batter: string | undefined
  ): void {
    this.scoredOnLastEvent = []
    this.unscoredOnLastEvent = []
    const a = event.attributes ?? {}
    const battingTeam = before.atBatTeamId

    switch (event.code) {
      case 'end_half':
        this.bases = new Map()
        break

      case 'replace_runner': {
        const outgoing = text(a.outgoingPlayerId)
        const base = this.baseForPlayer(outgoing)
        if (base !== undefined) {
          this.remove(outgoing)
          this.addToBase(base, text(a.incomingPlayerId), battingTeam)
        }
        break
      }

      case 'swap_players': {
        const first = text(a.firstPlayerId)
        const second = text(a.secondPlayerId)
        const firstBase = this.baseForPlayer(first)
        const secondBase = this.baseForPlayer(second)
        this.remove(first)
        this.remove(second)
        if (firstBase !== undefined)
          this.addToBase(firstBase, second, battingTeam)
        if (secondBase !== undefined)
          this.addToBase(secondBase, first, battingTeam)
        break
      }

      case 'sub_players': {
        if (a.applyToBaserunners !== true) break
        const incoming = text(a.incomingPlayerId)
        const outgoing = text(a.outgoingPlayerId)
        const outgoingBase = this.baseForPlayer(outgoing)
        this.remove(incoming)
        this.remove(outgoing)
        if (outgoingBase === undefined) break
        this.addToBase(outgoingBase, incoming, battingTeam)
        break
      }

      case 'end_at_bat':
        switch (text(a.reason)) {
          case 'walk':
          case 'hit_by_pitch':
          case 'catcher_interference':
            this.walk(batter, battingTeam)
            break
          default:
            break
        }
        break

      case 'balk':
        this.advanceAll(1, battingTeam)
        break

      case 'illegal_pitch_advance':
        this.advanceAll(1, battingTeam)
        if (after.lastEvent.walk) this.addToBase(1, batter, battingTeam)
        break

      case 'ball_in_play': {
        const config = ballInPlayConfig(a.playResult)
        const holdRunners =
          config.batterOut &&
          (before.outs === 2 ||
            a.playResult === 'dropped_third_strike_batter_out')
        if (!holdRunners) this.advanceAll(config.bases, battingTeam)
        if (!config.batterOut) {
          this.addToBase(config.bases, batter, battingTeam)
        }
        break
      }

      case 'base_running': {
        const playType = text(a.playType)
        const config = baseRunningConfig(playType)
        const runnerId = text(a.runnerId)
        const base = count(a.base)
        const from = this.baseForPlayer(runnerId) ?? 4
        if (from === 4) this.unscore(runnerId)
        else this.remove(runnerId)
        if (config.runnerOut || playType === 'did_not_score') break
        // A runner sent back stands behind the base, out of the way of the one
        // in front of them.
        if (from === 4 && base === 3) this.addToBase(-3, runnerId, battingTeam)
        else if (from === 3 && base === 2) {
          this.addToBase(-2, runnerId, battingTeam)
        } else this.addToBase(base, runnerId, battingTeam)
        break
      }

      case 'place_batter':
        this.addToBase(count(a.base), batter, battingTeam)
        break

      case 'place_runner':
        this.addToBase(count(a.base), text(a.runnerId), battingTeam)
        break

      case 'override':
        if (a.inning !== undefined || a.half !== undefined) {
          this.bases = new Map()
        }
        break

      case 'pitch':
        if (a.advancesRunners === true) this.advanceAll(1, battingTeam)
        if (after.lastEvent.walk) this.walk(batter, battingTeam)
        break

      default:
        break
    }

    if (after.lastEvent.endedInning) {
      this.bases = new Map()
      return
    }
    this.reconcileSentBack(-3, battingTeam)
    this.reconcileSentBack(-2, battingTeam)
  }

  private addToBase(
    base: number,
    playerId: string | undefined,
    teamId: string
  ): void {
    if (base >= 4) {
      if (playerId !== undefined) this.scoredOnLastEvent.push(playerId)
      return
    }
    this.bases.set(base, playerId)
  }

  private remove(playerId: string): void {
    const base = this.baseForPlayer(playerId)
    if (base !== undefined) this.bases.set(base, undefined)
  }

  private unscore(playerId: string): void {
    this.unscoredOnLastEvent.push(playerId)
  }

  /** Everybody ahead of an unoccupied base is forced up one. */
  private walk(batter: string | undefined, teamId: string): void {
    let firstUnoccupied = 1
    for (; firstUnoccupied <= 4; firstUnoccupied += 1) {
      if (this.bases.get(firstUnoccupied) === undefined) break
    }
    for (let base = firstUnoccupied; base > 1; base -= 1) {
      this.addToBase(base, this.bases.get(base - 1), teamId)
    }
    this.addToBase(1, batter, teamId)
  }

  private advanceAll(by: number, teamId: string): void {
    if (by === 0) return
    for (let base = 3; base >= 1; base -= 1) {
      const runnerId = this.bases.get(base)
      if (runnerId === undefined) continue
      this.addToBase(base + by, runnerId, teamId)
      this.bases.set(base, undefined)
    }
  }

  private reconcileSentBack(base: number, teamId: string): void {
    const sentBack = this.bases.get(base)
    if (sentBack === undefined) return
    if (this.bases.get(-base) !== undefined) return
    this.remove(sentBack)
    this.addToBase(-base, sentBack, teamId)
  }
}

/**
 * Everything a visitor may read about one event, as it stood *before* any of
 * the engines moved — plus the situation afterwards, because a walk is only
 * visible once the count has been reconciled.
 */
export interface EventContext {
  index: number
  event: StreamEvent
  before: SituationSnapshot
  after: SituationSnapshot
  /** The batter, from the lineup as it stood before the event. */
  batter: string | undefined
  /** The pitcher, from the field as it stood before the event. */
  pitcher: string | undefined
  baseForPlayer: (playerId: string) => number | undefined
  playerAtBase: (base: number) => string | undefined
  /** Who reached home on this event, once the bases have moved. */
  scored: string[]
  unscored: string[]
}

export interface GameVisitor {
  /** Before the lineup, the field and the bases move. */
  onEvent?: (context: EventContext) => void
  /** After they have. */
  onEventApplied?: (context: EventContext) => void
}

/** One walk over a game's events, with the four engines kept beside it. */
export function walkGame(streamEvents: unknown, visitor: GameVisitor): void {
  const events = compactEvents(streamEvents)
  const situation = new SituationEngine()
  const lineup = new LineupEngine()
  const fielders = new FieldersEngine()
  const baserunners = new BaserunnerEngine()

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const before = situation.snapshot()
    const batter = lineup.currentBatter(before.atBatTeamId)
    const pitcher = fielders.playerForPosition(before.inFieldTeamId, 'P')
    const bases = baserunners.snapshot()

    situation.apply(event)
    const after = situation.snapshot()

    const context: EventContext = {
      index,
      event,
      before,
      after,
      batter,
      pitcher,
      baseForPlayer: playerId => {
        for (const base of [1, 2, 3, -3, -2]) {
          if (bases.get(base) === playerId) return base
        }
        return undefined
      },
      playerAtBase: base => bases.get(base),
      scored: [],
      unscored: []
    }

    visitor.onEvent?.(context)

    baserunners.apply(event, before, after, batter)
    lineup.apply(event, before, after)
    fielders.apply(event, before)

    context.scored = baserunners.scoredOnLastEvent
    context.unscored = baserunners.unscoredOnLastEvent
    visitor.onEventApplied?.(context)
  }
}
