import type { ScoringAction } from '../../common/scoring/actions'
import { overrideOf } from '../../common/scoring/rules'
import { type Applied, applyAction } from '../../common/scoring/session'
import {
  copyGame,
  type GameState,
  POSITIONS,
  setupOf
} from '../../common/scoring/state'
import type { OverrideDraft } from './scoringTypes'

/** Preserve a matching occurrence; otherwise recover the batter by identity. */
export function overrideDraftOf(state: GameState): OverrideDraft {
  const original = overrideOf(state)
  const team = state.liveData.boxscore.teams[original.top ? 'away' : 'home']
  return {
    ...original,
    batterIndex:
      team.battingOrder[team.battingIndex] === original.batter
        ? team.battingIndex
        : original.batter == null
          ? undefined
          : team.battingOrder.indexOf(original.batter)
  }
}

/** Changing sides stages new players without touching the live game. */
export function overrideHalf(
  state: GameState,
  draft: OverrideDraft,
  top: boolean
): OverrideDraft {
  const original = overrideOf(state)
  const team = state.liveData.boxscore.teams[top ? 'away' : 'home']
  const bases = top === original.top ? original.bases : [null, null, null]
  const due = team.battingOrder[team.battingIndex]
  return {
    ...draft,
    top,
    batter: bases.includes(due) ? null : (due ?? null),
    batterIndex: team.battingIndex,
    pitcher: top === original.top ? original.pitcher : null,
    bases,
    pinchHitter: undefined
  }
}

/** The preview and the reducer use the same validated, atomic action list. */
export function overrideActions(
  state: GameState,
  draft: OverrideDraft,
  execute?: (state: GameState, action: ScoringAction) => Applied
): { actions: ScoringAction[]; error?: undefined } | { error: string } {
  const { pinchHitter, batterIndex, ...values } = draft
  const team = state.liveData.boxscore.teams[draft.top ? 'away' : 'home']
  const order = team.battingOrder
  if (draft.bases.length !== 3) return { error: 'Bases must have three slots.' }
  const actions: ScoringAction[] = [
    {
      type: 'gameFlow',
      kind: 'override',
      ...values,
      // A selected new turn must survive later roster repair. An unchanged
      // first occurrence needs no fold-5 slot metadata for a numeric edit.
      ...(batterIndex != null &&
      (batterIndex !== order.indexOf(draft.batter ?? -1) ||
        batterIndex !== team.battingIndex ||
        draft.batter !== state.liveData.linescore.offense.batter?.id)
        ? { batterIndex }
        : {}),
      batter: draft.batter ?? undefined,
      pitcher: draft.pitcher ?? undefined,
      ...(draft.pitcher == null &&
      (draft.top !== state.liveData.linescore.isTopInning ||
        state.liveData.linescore.defense.P != null)
        ? { clearPitcher: true }
        : {})
    }
  ]
  // A missing draft batter must not fall back to the live game's batter.
  if (draft.batter == null)
    return { error: 'Choose a batter from the batting team lineup.' }
  const apply =
    execute ??
    ((owned: GameState, action: ScoringAction) =>
      applyAction(owned, action, { inPlace: true }))
  const first = apply(execute == null ? copyGame(state) : state, actions[0])
  if (first.problems.length > 0) return { error: first.problems[0].message }
  if (pinchHitter != null) {
    const side = draft.top ? 'away' : 'home'
    const setup = setupOf(first.state)
    const team = setup.sides[side]
    if (
      !team.players.includes(pinchHitter) ||
      team.battingOrder.includes(pinchHitter) ||
      draft.bases.includes(pinchHitter)
    )
      return { error: 'Choose a bench player who is not on base.' }
    const slot = first.state.liveData.boxscore.teams[side].battingIndex
    team.battingOrder = team.battingOrder.map((id, index) =>
      index === slot ? pinchHitter : id
    )
    if (!team.battingOrder.includes(draft.batter))
      for (const position of POSITIONS)
        if (team.defense[position] === draft.batter)
          team.defense[position] = null
    const action: ScoringAction = {
      type: 'lineup',
      kind: 'roster',
      setup,
      player: pinchHitter,
      replaces: draft.batter,
      nextBatter: pinchHitter
    }
    const second = apply(first.state, action)
    if (second.problems.length > 0) return { error: second.problems[0].message }
    actions.push(action)
  }
  return { actions }
}
