import type { RosterEntry } from '../../common/api'
import {
  applyRosterCommands,
  type RosterCommand,
  type RosterSituation,
  type StagedRoster
} from '../../common/scoring/rosterCommands'
import { copyState, type GameState } from '../../common/scoring/state'
import {
  addRosteredPlayer,
  emptyPlayerDraft,
  type PlayerDraft,
  playerDraftError
} from './playerDraft'

export type CreateRosterPlayer = (
  teamId: string,
  player: PlayerDraft
) => Promise<RosterEntry>

/** Validate the entire sentence before creating anyone. Named players use the same
 * persistent roster operation as the form; only explicit placeholders stay local. */
export async function createDictatedPlayers(
  draft: GameState,
  commands: readonly RosterCommand[],
  situation: RosterSituation,
  create: CreateRosterPlayer | undefined,
  current: () => boolean = () => true
): Promise<StagedRoster | { problem: string }> {
  const checked = applyRosterCommands(draft, commands, situation)
  if ('problem' in checked) return checked
  if (
    !commands.some(
      command => command.type === 'addPlayer' && command.placeholder !== true
    )
  )
    return checked
  if (create == null)
    return { problem: 'Unable to create the player. Please try again.' }
  const additions = commands.flatMap(command => {
    if (command.type !== 'addPlayer') return []
    const [firstName, ...last] = command.name.trim().split(/\s+/)
    const player = {
      ...emptyPlayerDraft(),
      firstName,
      lastName: last.join(' '),
      jersey: command.jersey?.trim() ?? ''
    }
    return [{ command, player }]
  })
  for (const { player } of additions) {
    const error = playerDraftError(player)
    if (error != null) return { problem: error }
  }
  let next = copyState(draft)
  for (const { command, player } of additions) {
    if (!current()) return { problem: 'Player creation was interrupted.' }
    if (command.placeholder === true) {
      const staged = applyRosterCommands(next, [command], situation)
      if ('problem' in staged) return staged
      next = staged.draft
    } else {
      const entry = await create(next.gameData.teams[command.side].id, player)
      addRosteredPlayer(next, command.side, entry, player)
    }
  }
  return { ...checked, draft: next }
}
