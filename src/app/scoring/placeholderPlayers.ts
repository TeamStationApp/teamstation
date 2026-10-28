import type { RosterEntry } from '../../common/api'
import {
  placeholderSuffix,
  placeholderTeamName
} from '../../common/placeholderNames'
import {
  addPlayerDraft,
  emptyPlayerDraft,
  type PlayerDraft
} from './playerDraft'
import type { ScoringSessionState, Side } from './scoringTypes'

export { placeholderSuffix, placeholderTeamName }

export class PartialPlaceholderCreation extends Error {
  constructor(
    readonly created: number,
    readonly remaining: number
  ) {
    super(
      `Created ${created} ${created === 1 ? 'player' : 'players'}. Please retry to create the remaining ${remaining}.`
    )
  }
}

export async function addPlaceholderPlayers(
  session: ScoringSessionState,
  side: Side,
  count: number,
  create: (side: Side, player: PlayerDraft) => Promise<RosterEntry>
): Promise<number[]> {
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw new Error('Choose between 1 and 16 players.')
  const prefix = placeholderTeamName(session.gameData.teams[side].name)
  const names = new Set(
    session.liveData.boxscore.teams[side].players.map(id =>
      session.gameData.players[id].fullName.toLowerCase()
    )
  )
  const ids: number[] = []
  let suffix = 0
  while (ids.length < count) {
    const lastName = placeholderSuffix(suffix++)
    const name = `${prefix} ${lastName}`
    if (names.has(name.toLowerCase())) continue
    const draft = {
      ...emptyPlayerDraft(),
      firstName: prefix,
      lastName
    }
    let entry: RosterEntry
    try {
      entry = await create(side, draft)
    } catch (error) {
      if (ids.length > 0)
        throw new PartialPlaceholderCreation(ids.length, count - ids.length)
      throw error
    }
    ids.push(addPlayerDraft(session, side, draft, entry.gumboId!))
    names.add(name.toLowerCase())
  }
  return ids
}
