import { POSITIONS } from '../../../common/scoring/state'
import { createLineupGame, joinTeam } from '../lineupFixture'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  coach: { first: 'Aaron', last: 'Boone' },
  assistant: { first: 'Don', last: 'Mattingly' },
  peer: { first: 'Score', last: 'Peer' },
  scorekeeper: { first: 'Alex', last: 'Cora' }
}

/**
 * What the game plan's tests coach: the lineup game (Visitors at Hosts, with
 * thirteen players a side and each side's first nine as its default lineup),
 * the home team's head coach and its assistant, and a scorekeeper of the home
 * team who neither coaches nor assists. `homePlayer1` … `homePlayer9` are the
 * home lineup's gumbo ids, batting one to nine; player i wears i and is named
 * as `LINEUP_NAMES.home` names them.
 */
export async function runCoachGame(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'coach-game'
  const coach = await createAccount(context, world, 'coach', PEOPLE.coach)
  const assistant = await createAccount(
    context,
    world,
    'assistant',
    PEOPLE.assistant
  )
  const scorekeeper = await createAccount(
    context,
    world,
    'scorekeeper',
    PEOPLE.scorekeeper
  )
  const peer = await createAccount(context, world, 'peer', PEOPLE.peer)
  const game = await context.db.transaction().execute(async trx => {
    const made = await createLineupGame(trx)
    await joinTeam(trx, coach.userId, made.teams.home, 'coach')
    await joinTeam(trx, assistant.userId, made.teams.home, 'assistant')
    await joinTeam(trx, scorekeeper.userId, made.teams.home, 'scorekeeper')
    await joinTeam(trx, peer.userId, made.teams.home, 'scorekeeper')
    return made
  })
  const lineup = Object.fromEntries(
    game.players.home
      .slice(0, POSITIONS.length)
      .map((player, i) => [`homePlayer${i + 1}`, String(player.gumboId)])
  )
  return {
    world,
    nonce: context.nonce,
    accounts: { coach, assistant, scorekeeper, peer },
    ids: {
      game: game.gameId,
      homeTeam: game.teams.home,
      awayTeam: game.teams.away,
      ...lineup
    }
  }
}
