import { makeId } from '../../../common/ids'
import { joinTeam } from '../lineupFixture'
import { createScoringGame, userMinter } from '../scoringGame'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'
import { setDefaultLineups } from './scoringPreview'

/** The Tigers' nine, batting in this order: Blake B and Tom A lead off. */
export const WALK_UP_NAMES: Record<'home' | 'away', readonly string[]> = {
  away: [
    'Blake Butler',
    'Tom Allen',
    'Luis Arraez',
    'Max Muncy',
    'Gleyber Torres',
    'Willy Adames',
    'Ian Happ',
    'Bryan Reynolds',
    'Josh Naylor'
  ],
  home: [
    'Dansby Swanson',
    'Nico Hoerner',
    'Seiya Suzuki',
    'Cody Bellinger',
    'Christopher Morel',
    'Mike Tauchman',
    'Yan Gomes',
    'Miguel Amaya',
    'Justin Steele'
  ]
}

/**
 * The walk-up songs' scenarios: the Tigers at the Cubs, one scheduled game
 * with each team's nine as its default lineup. The Tigers' songkeeper is
 * also its scorekeeper (`songkeeper`), and a plain member of the Tigers
 * (`member`) neither keeps songs nor scores. Blake B (`ids.blake`) has an
 * Apple Music walk-up song, which no phone holds; Tom A (`ids.tom`) has none.
 */
export async function runWalkUp(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'walk-up'
  const songkeeper = await createAccount(context, world, 'songkeeper', {
    first: 'Vin',
    last: 'Scully'
  })
  const member = await createAccount(context, world, 'member', {
    first: 'Jon',
    last: 'Miller'
  })
  const made = await context.db.transaction().execute(async trx => {
    const game = await createScoringGame(trx, await userMinter(trx), {
      names: WALK_UP_NAMES,
      teams: { away: 'Tigers', home: 'Cubs' }
    })
    await setDefaultLineups(trx, game)
    const tigers = game.awayTeamId
    await joinTeam(trx, songkeeper.userId, tigers, 'scorekeeper')
    await trx
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: songkeeper.userId,
        scope_type: 'team',
        scope_id: tigers,
        role: 'songkeeper'
      })
      .execute()
    await joinTeam(trx, member.userId, tigers)
    const [blake, tom] = game.roster.away
    await trx
      .insertInto('walk_up_songs')
      .values({
        team_id: tigers,
        user_id: blake,
        provider: 'appleMusic',
        provider_id: '1440650428',
        isrc: null,
        title: 'Centerfield',
        artist: 'John Fogerty',
        album: 'Centerfield',
        artwork_url: null,
        duration_ms: 232_000,
        start_ms: 0,
        end_ms: 15_000,
        set_by: songkeeper.userId
      })
      .execute()
    return { game: game.games[0], tigers, cubs: game.homeTeamId, blake, tom }
  })
  return {
    world,
    nonce: context.nonce,
    accounts: { songkeeper, member },
    ids: {
      game: made.game,
      tigers: made.tigers,
      cubs: made.cubs,
      blake: made.blake,
      tom: made.tom
    }
  }
}
