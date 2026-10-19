import type { RosterEntry } from '../../common/api'
import {
  addPlayerDraft,
  emptyPlayerDraft,
  type PlayerDraft
} from './playerDraft'
import type { ScoringSessionState, Side } from './scoringTypes'

/** The only abbreviation policy for roster placeholders. Length includes spaces. */
export function placeholderTeamName(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  while (words[0]?.toLowerCase() === 'the') words.shift()
  const selected = words.slice(0, 3)
  const full = selected.join(' ')
  if (full === '') return 'Team'
  if (full.length <= 10) return full
  const shortened = full
    .replace(/[aeiou]/gi, '')
    .trim()
    .replace(/\s+/g, ' ')
  if (shortened === '') return 'Team'
  if (shortened.length <= 8) return shortened
  if (words.length > 2)
    return selected
      .map(word => word[0])
      .join('')
      .toUpperCase()
  const result = (
    selected.length === 2
      ? selected[0][0] + selected[1].replace(/[aeiou]/gi, '')
      : shortened
  ).slice(0, 8)
  return result === '' ? 'Team' : result
}
export function placeholderSuffix(index: number): string {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result
  return result
}

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
    ids.push(addPlayerDraft(session, side, draft, entry.userId))
    names.add(name.toLowerCase())
  }
  return ids
}
