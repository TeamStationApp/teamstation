import type { GumboPlay } from '../../common/gumboPlay'
import { battingTeamForHalf, type GameTeams } from '../events/eventWrite'

const PLATE_APPEARANCE = new Set([
  'single',
  'double',
  'triple',
  'home_run',
  'strikeout',
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'field_out',
  'grounded_into_double_play',
  'triple_play',
  'field_error',
  'fielders_choice',
  'catcher_interference',
  'sac_fly',
  'sac_bunt'
])

const COUNTED_NON_PA = new Set([
  'stolen_base',
  'caught_stealing',
  'wild_pitch',
  'passed_ball',
  'balk',
  'other_out'
])

const SKIPPED = new Set(['game_advisory', 'score_correction', 'final_score'])

const NON_AB = new Set([
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'catcher_interference',
  'sac_fly',
  'sac_bunt'
])

const HIT_TYPES = new Set(['single', 'double', 'triple', 'home_run'])

export interface PlayerGameLine {
  userId: number
  teamId: string | null
  pa: number
  ab: number
  h: number
  singles: number
  doubles: number
  triples: number
  hr: number
  bb: number
  k: number
  r: number
  rbi: number
  hbp: number
  ci: number
  sf: number
  sb: number
  cs: number
  pitch_bf: number
  pitch_outs: number
  pitch_h: number
  pitch_hr: number
  pitch_bb: number
  pitch_hbp: number
  pitch_k: number
  pitch_r: number
  pitch_er: number
}

export type GameStatResult =
  | { kind: 'lines'; lines: PlayerGameLine[] }
  | { kind: 'incomplete'; detail: string }

type FigureKey = Exclude<keyof PlayerGameLine, 'userId' | 'teamId'>

function emptyLine(userId: number, teamId: string | null): PlayerGameLine {
  return {
    userId,
    teamId,
    pa: 0,
    ab: 0,
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    r: 0,
    rbi: 0,
    hbp: 0,
    ci: 0,
    sf: 0,
    sb: 0,
    cs: 0,
    pitch_bf: 0,
    pitch_outs: 0,
    pitch_h: 0,
    pitch_hr: 0,
    pitch_bb: 0,
    pitch_hbp: 0,
    pitch_k: 0,
    pitch_r: 0,
    pitch_er: 0
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * GumboPlay's runner cleaner only types `details.runner`; `.withRest` keeps
 * `movement`, `eventType`, `responsiblePitcher`, etc. at runtime. Read those
 * through a record so we do not re-narrow typed fields via `isRecord`.
 */
function runnerDoc(
  entry: NonNullable<GumboPlay['runners']>[number]
): Record<string, unknown> {
  return entry as Record<string, unknown>
}

function isSafeUserId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
}

function pitchingTeamForHalf(
  halfInning: string | null | undefined,
  teams: GameTeams
): string | null {
  if (halfInning === 'top') return teams.homeTeamId
  if (halfInning === 'bottom') return teams.awayTeamId
  return null
}

function missing(atBatIndex: number, path: string): GameStatResult {
  return { kind: 'incomplete', detail: `play ${atBatIndex}: ${path} missing` }
}

function notAUser(
  atBatIndex: number,
  path: string,
  id: unknown
): GameStatResult {
  return {
    kind: 'incomplete',
    detail: `play ${atBatIndex}: ${path}.id ${String(id)} is not a user`
  }
}

/**
 * Resolve a player object. Absent id → drop the figure. Present id must be a
 * known user. Required fields that are missing are handled by the caller.
 */
function resolveId(
  player: Record<string, unknown>,
  path: string,
  atBatIndex: number,
  knownUsers: ReadonlySet<number>
): { id: number | null } | { incomplete: GameStatResult } {
  if (!('id' in player) || player.id == null) return { id: null }
  if (!isSafeUserId(player.id) || !knownUsers.has(player.id)) {
    return { incomplete: notAUser(atBatIndex, path, player.id) }
  }
  return { id: player.id }
}

function addFigure(
  lines: Map<number, PlayerGameLine>,
  userId: number | null,
  teamId: string | null,
  field: FigureKey,
  n: number
): void {
  if (userId == null || n === 0) return
  let line = lines.get(userId)
  if (line == null) {
    line = emptyLine(userId, teamId)
    lines.set(userId, line)
  }
  line[field] += n
}

export function gameStatLines(
  plays: GumboPlay[],
  teams: GameTeams,
  knownUsers: ReadonlySet<number>
): GameStatResult {
  const lines = new Map<number, PlayerGameLine>()
  let awayRuns = 0
  let homeRuns = 0
  let outsHalfKey: string | null = null
  let outsBefore = 0

  for (const play of plays) {
    const about = play.about
    const atBatIndex =
      typeof about.atBatIndex === 'number' ? about.atBatIndex : 0
    const eventType =
      play.result != null && typeof play.result.eventType === 'string'
        ? play.result.eventType
        : ''

    if (SKIPPED.has(eventType)) continue
    if (!PLATE_APPEARANCE.has(eventType) && !COUNTED_NON_PA.has(eventType)) {
      continue
    }

    const isPa = PLATE_APPEARANCE.has(eventType)

    if (about.inning == null) return missing(atBatIndex, 'about.inning')
    if (about.halfInning == null) return missing(atBatIndex, 'about.halfInning')
    const halfInning = about.halfInning
    const inning = about.inning

    const matchup = play.matchup
    if (matchup == null || matchup.pitcher == null) {
      return missing(atBatIndex, 'matchup.pitcher')
    }
    const pitcherResolved = resolveId(
      matchup.pitcher as Record<string, unknown>,
      'matchup.pitcher',
      atBatIndex,
      knownUsers
    )
    if ('incomplete' in pitcherResolved) return pitcherResolved.incomplete
    const matchupPitcherId = pitcherResolved.id

    const count = play.count
    if (count?.outs == null) {
      return missing(atBatIndex, 'count.outs')
    }
    if (typeof count.outs !== 'number') {
      return missing(atBatIndex, 'count.outs')
    }
    const outsAfter = count.outs

    if (!Array.isArray(play.runners)) {
      return missing(atBatIndex, 'runners')
    }
    const runners = play.runners

    let batterId: number | null = null
    if (isPa) {
      if (matchup.batter == null) {
        return missing(atBatIndex, 'matchup.batter')
      }
      const batterResolved = resolveId(
        matchup.batter as Record<string, unknown>,
        'matchup.batter',
        atBatIndex,
        knownUsers
      )
      if ('incomplete' in batterResolved) return batterResolved.incomplete
      batterId = batterResolved.id

      const batterEntry = runners.find(entry => {
        const row = runnerDoc(entry)
        if (!isRecord(row.movement)) return false
        if (row.movement.start != null) return false
        if (!isRecord(row.details) || !isRecord(row.details.runner)) {
          return false
        }
        const runner = row.details.runner
        if (batterId == null) return runner.id == null
        return runner.id === batterId
      })
      if (batterEntry == null) {
        return missing(atBatIndex, 'runners batter entry')
      }
    }

    const battingTeam = battingTeamForHalf(halfInning, teams)
    const pitchingTeam = pitchingTeamForHalf(halfInning, teams)

    const halfKey = `${String(inning)}:${halfInning}`
    if (halfKey !== outsHalfKey) {
      outsHalfKey = halfKey
      outsBefore = 0
    }
    const outsDelta = outsAfter - outsBefore
    outsBefore = outsAfter

    // Validate runner entries and collect out-entry pitcher overrides.
    const outPitcherOverrides: Array<number | null> = []
    let walkOwnerId: number | null = matchupPitcherId

    for (let i = 0; i < runners.length; i++) {
      const row = runnerDoc(runners[i])
      if (!isRecord(row.movement)) continue

      const path = `runners[${i}]`
      const movement = row.movement
      const details = isRecord(row.details) ? row.details : null
      if (details == null || !isRecord(details.runner)) {
        return missing(atBatIndex, `${path}.details.runner`)
      }
      if (typeof details.eventType !== 'string') {
        return missing(atBatIndex, `${path}.details.eventType`)
      }

      const isOut = movement.isOut === true
      if (!isOut && movement.end == null) {
        return missing(atBatIndex, `${path}.movement.end`)
      }

      const runnerResolved = resolveId(
        details.runner,
        `${path}.details.runner`,
        atBatIndex,
        knownUsers
      )
      if ('incomplete' in runnerResolved) return runnerResolved.incomplete

      if (isOut) {
        if (isRecord(details.pitcher)) {
          const outPitcher = resolveId(
            details.pitcher,
            `${path}.details.pitcher`,
            atBatIndex,
            knownUsers
          )
          if ('incomplete' in outPitcher) return outPitcher.incomplete
          if (outPitcher.id != null && outPitcher.id !== matchupPitcherId) {
            outPitcherOverrides.push(outPitcher.id)
          }
        }
      }

      if (movement.end === 'score') {
        if (!isRecord(details.responsiblePitcher)) {
          return missing(atBatIndex, `${path}.details.responsiblePitcher`)
        }
        if (typeof details.earned !== 'boolean') {
          return missing(atBatIndex, `${path}.details.earned`)
        }
        if (typeof details.rbi !== 'boolean') {
          return missing(atBatIndex, `${path}.details.rbi`)
        }
        const rp = resolveId(
          details.responsiblePitcher,
          `${path}.details.responsiblePitcher`,
          atBatIndex,
          knownUsers
        )
        if ('incomplete' in rp) return rp.incomplete
      }

      // Walk owner from the batter's entry.
      if (
        isPa &&
        (eventType === 'walk' || eventType === 'intent_walk') &&
        movement.start == null &&
        isRecord(details.responsiblePitcher)
      ) {
        const owner = resolveId(
          details.responsiblePitcher,
          `${path}.details.responsiblePitcher`,
          atBatIndex,
          knownUsers
        )
        if ('incomplete' in owner) return owner.incomplete
        if (owner.id != null) walkOwnerId = owner.id
      }
    }

    // pitch_outs
    let assignedOverrides = 0
    for (const pitcherId of outPitcherOverrides) {
      if (assignedOverrides >= outsDelta) break
      addFigure(lines, pitcherId, pitchingTeam, 'pitch_outs', 1)
      assignedOverrides++
    }
    const restOuts = outsDelta - assignedOverrides
    if (restOuts > 0) {
      addFigure(lines, matchupPitcherId, pitchingTeam, 'pitch_outs', restOuts)
    }

    if (isPa) {
      addFigure(lines, batterId, battingTeam, 'pa', 1)
      if (!NON_AB.has(eventType)) {
        addFigure(lines, batterId, battingTeam, 'ab', 1)
      }
      addFigure(lines, matchupPitcherId, pitchingTeam, 'pitch_bf', 1)

      if (HIT_TYPES.has(eventType)) {
        addFigure(lines, batterId, battingTeam, 'h', 1)
        addFigure(lines, matchupPitcherId, pitchingTeam, 'pitch_h', 1)
        if (eventType === 'single') {
          addFigure(lines, batterId, battingTeam, 'singles', 1)
        } else if (eventType === 'double') {
          addFigure(lines, batterId, battingTeam, 'doubles', 1)
        } else if (eventType === 'triple') {
          addFigure(lines, batterId, battingTeam, 'triples', 1)
        } else if (eventType === 'home_run') {
          addFigure(lines, batterId, battingTeam, 'hr', 1)
          addFigure(lines, matchupPitcherId, pitchingTeam, 'pitch_hr', 1)
        }
      } else if (eventType === 'walk' || eventType === 'intent_walk') {
        addFigure(lines, batterId, battingTeam, 'bb', 1)
        addFigure(lines, walkOwnerId, pitchingTeam, 'pitch_bb', 1)
        if (walkOwnerId != null && walkOwnerId !== matchupPitcherId) {
          addFigure(lines, walkOwnerId, pitchingTeam, 'pitch_bf', 1)
        }
      } else if (eventType === 'strikeout') {
        addFigure(lines, batterId, battingTeam, 'k', 1)
        addFigure(lines, matchupPitcherId, pitchingTeam, 'pitch_k', 1)
      } else if (eventType === 'hit_by_pitch') {
        addFigure(lines, batterId, battingTeam, 'hbp', 1)
        addFigure(lines, matchupPitcherId, pitchingTeam, 'pitch_hbp', 1)
      } else if (eventType === 'catcher_interference') {
        addFigure(lines, batterId, battingTeam, 'ci', 1)
      } else if (eventType === 'sac_fly' || eventType === 'sac_bunt') {
        addFigure(lines, batterId, battingTeam, 'sf', 1)
      }
    }

    for (const entry of runners) {
      const row = runnerDoc(entry)
      if (!isRecord(row.movement)) continue
      const details = isRecord(row.details) ? row.details : null
      if (details == null || !isRecord(details.runner)) continue
      const runner = details.runner
      // Invalid ids were already rejected above; absent id drops the figure.
      const creditedRunner =
        runner.id == null
          ? null
          : isSafeUserId(runner.id) && knownUsers.has(runner.id)
            ? runner.id
            : null

      const eventTypeDetail =
        typeof details.eventType === 'string' ? details.eventType : ''

      if (eventTypeDetail.startsWith('stolen_base')) {
        addFigure(lines, creditedRunner, battingTeam, 'sb', 1)
      } else if (eventTypeDetail.startsWith('caught_stealing')) {
        addFigure(lines, creditedRunner, battingTeam, 'cs', 1)
      }

      if (row.movement.end === 'score') {
        if (halfInning === 'top') awayRuns++
        else if (halfInning === 'bottom') homeRuns++

        addFigure(lines, creditedRunner, battingTeam, 'r', 1)
        if (details.rbi === true) {
          addFigure(lines, batterId, battingTeam, 'rbi', 1)
        }

        const rp = isRecord(details.responsiblePitcher)
          ? details.responsiblePitcher
          : null
        const rpId =
          rp == null || rp.id == null
            ? null
            : isSafeUserId(rp.id) && knownUsers.has(rp.id)
              ? rp.id
              : null
        addFigure(lines, rpId, pitchingTeam, 'pitch_r', 1)
        if (details.earned === true) {
          addFigure(lines, rpId, pitchingTeam, 'pitch_er', 1)
        }
      }
    }
  }

  if (plays.length > 0) {
    const last = plays[plays.length - 1]
    const result = last.result
    if (
      result != null &&
      typeof result.awayScore === 'number' &&
      typeof result.homeScore === 'number'
    ) {
      if (awayRuns !== result.awayScore || homeRuns !== result.homeScore) {
        return {
          kind: 'incomplete',
          detail:
            `runs from runners (away ${awayRuns}, home ${homeRuns}) ` +
            `do not match the score (away ${result.awayScore}, home ${result.homeScore})`
        }
      }
    }
  }

  return {
    kind: 'lines',
    lines: [...lines.values()].sort((a, b) => a.userId - b.userId)
  }
}
