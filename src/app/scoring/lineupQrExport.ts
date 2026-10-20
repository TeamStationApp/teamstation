import type { GameChangerLineup, GameChangerPlayer } from './lineupQrCodec'
import { packGameId, packPlayerId, packTeamId } from './lineupQrIds'
import { FIELD_CODES } from './lineupQrImport'
import type {
  Position,
  ScoringPlayer,
  ScoringSessionState,
  Side
} from './scoringTypes'

const CODE_OF = Object.fromEntries(
  Object.entries(FIELD_CODES).map(([code, position]) => [
    position,
    Number(code)
  ])
) as Record<Position, number>
const EH = 11
const DH = 12

/** A player's first and last names, split from his full name if need be. */
function namesOf(player: ScoringPlayer): { f: string; l: string } {
  if (`${player.firstName ?? ''}${player.lastName ?? ''}`.trim() !== '')
    return { f: player.firstName ?? '', l: player.lastName ?? '' }
  const full = player.fullName.trim()
  const space = full.lastIndexOf(' ')
  return space < 0
    ? { f: full, l: '' }
    : { f: full.slice(0, space), l: full.slice(space + 1) }
}

/**
 * One side's lineup as GameChanger's lineup QR code holds it: the batting
 * order with each batter's place on the field, and the fielders who do not
 * bat. A batter with no place is a DH for as many as there are fielders who
 * do not bat, and an EH after that. Bench players are left out, and an
 * incomplete lineup is shared as it stands.
 */
export function lineupQrOf(
  draft: ScoringSessionState,
  side: Side
): GameChangerLineup {
  const team = draft.liveData.boxscore.teams[side]
  const placeOf = new Map<number, Position>()
  for (const [position, id] of Object.entries(team.defense))
    if (id != null) placeOf.set(id, position as Position)
  const player = (id: number, p: number): GameChangerPlayer => {
    const person = draft.gameData.players[id]
    return {
      i: packPlayerId(id),
      ...namesOf(person),
      n: person.jersey.trim(),
      p
    }
  }
  const fielders = [...placeOf.keys()].filter(
    id => !team.battingOrder.includes(id)
  )
  let designated = fielders.length
  const h = team.battingOrder.map(id => {
    const position = placeOf.get(id)
    if (position != null) return player(id, CODE_OF[position])
    if (designated > 0) {
      designated--
      return player(id, DH)
    }
    return player(id, EH)
  })
  return {
    e: packGameId(draft.gamePk),
    t: packTeamId(draft.gameData.teams[side].id),
    h,
    n: fielders.map(id => player(id, 100 + CODE_OF[placeOf.get(id)!]))
  }
}
