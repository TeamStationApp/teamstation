import type { RosterEntry } from '../../common/api'
import {
  applyRosterCommands,
  type RosterCommand,
  rosterCommandScope,
  type RosterSituation,
  type StagedRoster
} from '../../common/scoring/rosterCommands'
import type { GameState, Side } from '../../common/scoring/state'
import {
  emptyPlayerDraft,
  type PlayerDraft,
  playerDraftError
} from './playerDraft'

export type CreateRosterPlayer = (
  teamId: string,
  player: PlayerDraft
) => Promise<RosterEntry>

/** Validate the entire sentence before creating anyone. Named players use the same
 * persistent roster operation as the form; placeholders are persisted as guests. */
export async function createDictatedPlayers(
  draft: GameState,
  commands: readonly RosterCommand[],
  situation: RosterSituation,
  create: CreateRosterPlayer | undefined,
  current: () => boolean = () => true,
  completed = new Map<string, RosterEntry>(),
  createGuest?: (side: Side, player: PlayerDraft) => Promise<RosterEntry>
): Promise<StagedRoster | { problem: string }> {
  const checked = rosterCommandScope(commands, situation)
  if ('problem' in checked) return checked
  if (!commands.some(command => command.type === 'addPlayer'))
    return applyRosterCommands(draft, commands, situation)
  if (
    commands.some(
      command =>
        command.type === 'addPlayer' &&
        (command.placeholder === true ? createGuest == null : create == null)
    )
  )
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
  const minted = new Map<RosterCommand, RosterEntry>()
  for (const [index, { command, player }] of additions.entries()) {
    if (!current()) return { problem: 'Player creation was interrupted.' }
    const teamId = draft.gameData.teams[command.side].id
    const key = JSON.stringify([
      index,
      command.placeholder === true ? 'guest' : 'roster',
      teamId,
      player
    ])
    const entry =
      completed.get(key) ??
      (command.placeholder === true
        ? await createGuest!(command.side, player)
        : await create!(teamId, player))
    completed.set(key, entry)
    minted.set(command, entry)
  }
  if (!current()) return { problem: 'Player creation was interrupted.' }
  const result = applyRosterCommands(
    draft,
    commands.map(command =>
      command.type === 'addPlayer'
        ? { ...command, player: minted.get(command)!.userId }
        : command
    ),
    situation
  )
  if ('problem' in result) return result
  for (const { command, player } of additions) {
    const entry = minted.get(command)!
    Object.assign(result.draft.gameData.players[entry.userId], {
      ...player,
      fullName: entry.shortName,
      local: command.placeholder === true
    })
  }
  return result
}
