import type { ScoringAction } from '../../common/scoring/actions'
import {
  applyRosterCommands,
  resolveRosterCommands,
  ROSTER_CATEGORY,
  ROSTER_TAB,
  rosterSituation,
  type SaidRosterCommand
} from '../../common/scoring/rosterCommands'
import type { GameState } from '../../common/scoring/state'
import { lstrings } from '../locales/strings'
import type { RosterEditorDraft } from './RosterEditor'

/**
 * A substitution said on the scoring screen: "number 3 subs in at third
 * base", "Betts pinch hits", "Freeman runs for the runner on second". It is
 * not scored there. It opens the roster sheet with the change staged on the
 * tab and team it is about, and the chat showing what was said, for the
 * scorer to save or cancel.
 */
export interface DictatedRoster {
  transcript: string
  /** The commands as said, whose players are found on the game it opens over. */
  commands: SaidRosterCommand[]
}

/** Why a refreshed game could not be read for the roster sheet. */
export const UNREFRESHED = 'Unable to refresh the game. Please try again.'
/** Why a substitution is not taken while a play is being entered. */
export const FINISH_THE_PLAY = 'Finish the current play first'

/**
 * What the scoring screen does with a sentence's roster commands: nothing
 * here when there are none, as the sentence is a play; a refusal for the
 * scoring log when it is a play and a substitution together, when a play is
 * being entered, or when a player said is nobody on `game` or the commands
 * do not apply to it; and otherwise the substitution, for the roster sheet,
 * which asks which player was meant when one said fits two or more. Whether
 * the lineup has been accepted does not matter: a scorer may say the opening
 * lineup.
 */
export function rosterReply(
  game: GameState,
  transcript: string,
  actions: readonly ScoringAction[],
  roster: readonly SaidRosterCommand[],
  atRest: boolean
): null | { problem: string } | { dictated: DictatedRoster } {
  if (roster.length === 0) return null
  if (actions.length > 0)
    return { problem: lstrings.dictation_substitution_separately }
  if (!atRest) return { problem: FINISH_THE_PLAY }
  const staged = dictatedSheet(game, { transcript, commands: [...roster] })
  return 'problem' in staged
    ? staged
    : { dictated: { transcript, commands: [...roster] } }
}

/**
 * The roster sheet as a substitution opens it, over `game`: its players
 * found, and the change staged on the draft, with its pinch runners and the
 * batter it sends up, on the tab and team it is about, and the chat's first
 * turn the words and what they did. A player said who fits two or more
 * opens it on the tab the change is about, nothing staged, and the chat
 * asking which. Or why it does not apply.
 */
export function dictatedSheet(
  game: GameState,
  { transcript, commands }: DictatedRoster
): RosterEditorDraft | { problem: string } {
  const situation = rosterSituation(game)
  const found = resolveRosterCommands(game, commands, situation)
  if ('problem' in found) return found
  if ('question' in found) {
    const sides = new Set(found.question.options.map(option => option.side))
    return {
      draft: game,
      side: sides.size === 1 ? [...sides][0] : situation.battingSide,
      mode: ROSTER_TAB[ROSTER_CATEGORY[commands[0].type]],
      base: game,
      chat: [{ key: 0, said: transcript, lines: [] }],
      question: found.question
    }
  }
  const staged = applyRosterCommands(game, found.commands, situation)
  if ('problem' in staged) return staged
  return {
    draft: staged.draft,
    side: staged.side,
    mode: ROSTER_TAB[staged.category],
    base: game,
    ...(staged.nextBatter == null ? {} : { nextBatter: staged.nextBatter }),
    ...(staged.runners.length === 0 ? {} : { runners: staged.runners }),
    chat: [
      {
        key: 0,
        said: transcript,
        lines: staged.lines.map(text => ({ kind: 'done' as const, text }))
      }
    ]
  }
}

/**
 * Opens the roster sheet on a substitution, built on the latest game: the
 * game is refreshed first, and the commands applied again over what comes
 * back, so another scorer's change saved meanwhile is kept under it. Only
 * then is the sheet opened. A refresh that fails, or a game on which the
 * commands no longer apply, opens nothing and says why.
 */
export async function openDictatedRosters(
  dictated: DictatedRoster,
  refresh: () => Promise<GameState | null>,
  outcome: {
    open: (initial: RosterEditorDraft) => void
    refuse: (problem: string) => void
  }
): Promise<void> {
  const fresh = await refresh().catch(() => null)
  if (fresh == null) {
    outcome.refuse(UNREFRESHED)
    return
  }
  const sheet = dictatedSheet(fresh, dictated)
  if ('problem' in sheet) outcome.refuse(sheet.problem)
  else outcome.open(sheet)
}
