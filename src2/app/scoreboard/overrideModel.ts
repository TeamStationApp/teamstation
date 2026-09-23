import {
  type DashboardOverrides,
  NO_OVERRIDES,
  type ScoreboardState
} from '../../common/scoreboard'

/**
 * What the override dashboard does to a board, as a pure reducer.
 *
 * Each tile group — the teams, the score, the inning, the bases and the
 * count — is overridden on its own. The first edit to a group turns it on
 * and seeds its values from the automated board, so the tile starts from
 * what is showing; later edits change what the group already holds. A tap
 * on a score or the inning number adds one, and the number picker sets any
 * value. A group's ✕ turns it off, so the tile shows the automated values
 * again, and Reset turns every group off. The dashboard sends the whole
 * overrides object after every change, as 1.0's did.
 */
export interface OverrideModel {
  automated: ScoreboardState
  overrides: DashboardOverrides
}

export type OverrideGroup = 'team' | 'score' | 'inning' | 'bases' | 'count'
export type CountRow = 'balls' | 'strikes' | 'outs'
export type Side = 'home' | 'away'
export type BaseName = 'base1' | 'base2' | 'base3'

/** Where each count row stops, as 1.0's `incrementBalls` and its siblings did. */
export const COUNT_LIMIT: Record<CountRow, number> = {
  balls: 3,
  strikes: 2,
  outs: 2
}

export type OverrideAction =
  | { type: 'setTeam'; side: Side; name: string }
  | { type: 'setScore'; side: Side; score: number }
  | { type: 'incrementScore'; side: Side }
  | { type: 'setInning'; inning: number }
  | { type: 'incrementInning' }
  | { type: 'toggleHalf'; half: 'top' | 'bottom' }
  | { type: 'toggleBase'; base: BaseName }
  | { type: 'incrementCount'; row: CountRow }
  | { type: 'clearCount'; row: CountRow }
  | { type: 'revert'; group: OverrideGroup }
  | { type: 'reset' }

const FLAG = {
  team: 'overrideTeamEnabled',
  score: 'overrideScoreEnabled',
  inning: 'overrideInningEnabled',
  bases: 'overrideBasesEnabled',
  count: 'overrideCountEnabled'
} as const
const VALUES = {
  team: 'overrideTeam',
  score: 'overrideScore',
  inning: 'overrideInning',
  bases: 'overrideBases',
  count: 'overrideCount'
} as const

export function isOverridden(
  overrides: DashboardOverrides,
  group: OverrideGroup
): boolean {
  return overrides[FLAG[group]] && overrides[VALUES[group]] != null
}

/** A group's values: its own while it is on, the automated board's otherwise. */
function teamOf(model: OverrideModel): { homeTeam: string; awayTeam: string } {
  const { overrides, automated } = model
  return isOverridden(overrides, 'team') && overrides.overrideTeam != null
    ? overrides.overrideTeam
    : { homeTeam: automated.homeTeam, awayTeam: automated.awayTeam }
}
function scoreOf(model: OverrideModel): {
  homeScore: number
  awayScore: number
} {
  const { overrides, automated } = model
  return isOverridden(overrides, 'score') && overrides.overrideScore != null
    ? overrides.overrideScore
    : { homeScore: automated.homeScore, awayScore: automated.awayScore }
}
function inningOf(model: OverrideModel): {
  inning: number
  half: ScoreboardState['half']
} {
  const { overrides, automated } = model
  return isOverridden(overrides, 'inning') && overrides.overrideInning != null
    ? overrides.overrideInning
    : { inning: automated.inning, half: automated.half }
}
function basesOf(model: OverrideModel): Record<BaseName, boolean> {
  const { overrides, automated } = model
  return isOverridden(overrides, 'bases') && overrides.overrideBases != null
    ? overrides.overrideBases
    : { base1: automated.base1, base2: automated.base2, base3: automated.base3 }
}
function countOf(model: OverrideModel): Record<CountRow, number> {
  const { overrides, automated } = model
  return isOverridden(overrides, 'count') && overrides.overrideCount != null
    ? overrides.overrideCount
    : {
        balls: automated.balls,
        strikes: automated.strikes,
        outs: automated.outs
      }
}

function withOverrides(
  model: OverrideModel,
  change: Partial<DashboardOverrides>
): OverrideModel {
  return { ...model, overrides: { ...model.overrides, ...change } }
}

export function overrideReducer(
  model: OverrideModel,
  action: OverrideAction
): OverrideModel {
  switch (action.type) {
    case 'setTeam': {
      const team = teamOf(model)
      return withOverrides(model, {
        overrideTeamEnabled: true,
        overrideTeam: {
          ...team,
          [action.side === 'home' ? 'homeTeam' : 'awayTeam']: action.name
        }
      })
    }
    case 'setScore': {
      const score = scoreOf(model)
      return withOverrides(model, {
        overrideScoreEnabled: true,
        overrideScore: {
          ...score,
          [action.side === 'home' ? 'homeScore' : 'awayScore']: Math.max(
            0,
            Math.round(action.score)
          )
        }
      })
    }
    case 'incrementScore': {
      // A tap on a score adds a run, as it did in 1.0.
      const score = scoreOf(model)
      const key = action.side === 'home' ? 'homeScore' : 'awayScore'
      return overrideReducer(model, {
        type: 'setScore',
        side: action.side,
        score: score[key] + 1
      })
    }
    case 'incrementInning':
      // A tap on the inning number moves to the next, as it did in 1.0.
      return overrideReducer(model, {
        type: 'setInning',
        inning: inningOf(model).inning + 1
      })
    case 'setInning':
      return withOverrides(model, {
        overrideInningEnabled: true,
        overrideInning: {
          ...inningOf(model),
          inning: Math.max(1, Math.round(action.inning))
        }
      })
    case 'toggleHalf': {
      // Pressing the half already showing sets 'mid', between halves, as
      // 1.0's arrows did.
      const inning = inningOf(model)
      return withOverrides(model, {
        overrideInningEnabled: true,
        overrideInning: {
          ...inning,
          half: inning.half === action.half ? 'mid' : action.half
        }
      })
    }
    case 'toggleBase': {
      const bases = basesOf(model)
      return withOverrides(model, {
        overrideBasesEnabled: true,
        overrideBases: { ...bases, [action.base]: !bases[action.base] }
      })
    }
    case 'incrementCount': {
      const count = countOf(model)
      return withOverrides(model, {
        overrideCountEnabled: true,
        overrideCount: {
          ...count,
          [action.row]: Math.min(COUNT_LIMIT[action.row], count[action.row] + 1)
        }
      })
    }
    case 'clearCount':
      return withOverrides(model, {
        overrideCountEnabled: true,
        overrideCount: { ...countOf(model), [action.row]: 0 }
      })
    case 'revert': {
      // Off, and the group's values dropped, so the next edit seeds afresh.
      const { [VALUES[action.group]]: dropped, ...rest } = model.overrides
      return {
        ...model,
        overrides: { ...rest, [FLAG[action.group]]: false }
      }
    }
    case 'reset':
      return { ...model, overrides: NO_OVERRIDES }
  }
}

/**
 * One overrides object as a string, the same for the same meaning whatever
 * order its keys arrived in, so what the dashboard sent can be recognised
 * when the server sends it back.
 */
export function overridesKey(overrides: DashboardOverrides): string {
  const groups = (Object.keys(FLAG) as OverrideGroup[]).map(group => [
    overrides[FLAG[group]],
    isOverridden(overrides, group) ? valuesKey(overrides, group) : null
  ])
  return JSON.stringify(groups)
}
function valuesKey(
  overrides: DashboardOverrides,
  group: OverrideGroup
): unknown[] {
  const values = overrides[VALUES[group]] as Record<string, unknown>
  return Object.keys(values)
    .sort()
    .map(key => [key, values[key]])
}

/**
 * Whether the dashboard should take the server's overrides.
 *
 * Every change is sent at once and comes back in a state message a moment
 * later. Two taps in quick succession would otherwise be undone and redone
 * on screen as the first echo lands, and a third tap in between would build
 * on the stale echo. So while anything this dashboard sent is still to come
 * back, the dashboard keeps its own overrides; the echo of the latest one
 * clears the queue, and from then on the server's word is taken, including
 * a change made on another dashboard.
 */
export function acceptServerOverrides(
  pending: readonly string[],
  incoming: DashboardOverrides
): { pending: string[]; adopt: boolean } {
  const at = pending.indexOf(overridesKey(incoming))
  const left = at < 0 ? [...pending] : pending.slice(at + 1)
  return { pending: left, adopt: left.length === 0 }
}
