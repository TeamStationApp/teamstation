import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { addEmail, findUserByEmail } from '../auth/emails'
import { hashPassword } from '../auth/passwords'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * A fresh game to score while developing: a league, a season, two teams in it
 * with twelve rostered players each, and `--games <n>` scheduled games (one
 * by default) between them with no plays, no score and no scoring owner. It
 * also creates or updates a viewer — not an administrator — who is a member of
 * the home team, so the viewer can see the games and manages neither team.
 *
 *   npm run scoring-game -- viewer@example.com hunter2 --games 2
 *
 * Prints each game id and the user ids of the first nine players a side, in
 * batting order.
 */
const POSITIONS = ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The scoring-game script does not run in production')
  }
  const args = process.argv.slice(2)
  const gamesAt = args.indexOf('--games')
  const count = gamesAt < 0 ? 1 : Number(args[gamesAt + 1])
  const [email, password] = args.filter(
    (arg, i) => arg !== '--games' && (gamesAt < 0 || i !== gamesAt + 1)
  )
  if (
    email == null ||
    password == null ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    throw new Error(
      'Usage: npm run scoring-game -- <viewerEmail> <viewerPassword> [--games <n>]'
    )
  }

  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const out = await db.transaction().execute(async trx => {
      const held = new Set(
        (await trx.selectFrom('users').select('id').execute()).map(
          row => row.id
        )
      )
      const mint = (): { userId: number; legacyId: string } => {
        const minted = mintUserId(id => held.has(id))
        held.add(minted.userId)
        return minted
      }
      const stamp = Date.now().toString(36)
      const leagueId = makeId('league')
      const seasonId = makeId('season')
      const homeTeamId = makeId('team')
      const awayTeamId = makeId('team')
      await trx
        .insertInto('leagues')
        .values({
          id: leagueId,
          name: `Scoring League ${stamp}`,
          short_name: 'SCR'
        })
        .execute()
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          league_id: leagueId,
          name: `Scoring Season ${stamp}`,
          year: 2026,
          term: 'Fall'
        })
        .execute()
      await trx
        .insertInto('teams')
        .values([
          { id: homeTeamId, name: `Hosts ${stamp}` },
          { id: awayTeamId, name: `Visitors ${stamp}` }
        ])
        .execute()
      await trx
        .insertInto('season_teams')
        .values([
          { season_id: seasonId, team_id: homeTeamId },
          { season_id: seasonId, team_id: awayTeamId }
        ])
        .execute()

      const roster: Record<'home' | 'away', number[]> = { home: [], away: [] }
      for (const [side, teamId] of [
        ['away', awayTeamId],
        ['home', homeTeamId]
      ] as const)
        for (let i = 0; i < 12; i++) {
          const minted = mint()
          // Padded so the roster, which lists players by name, lists them in
          // this order: the first nine bat one to nine and play P to RF.
          const number = String(i + 1).padStart(2, '0')
          const name = `${side === 'home' ? 'Host' : 'Visitor'} ${number}`
          await trx
            .insertInto('users')
            .values({
              id: minted.userId,
              legacyId: minted.legacyId,
              display_name: name,
              first_name: name.split(' ')[0],
              last_name: number,
              bats: i % 3 === 0 ? 'left' : 'right',
              throws: 'right'
            })
            .execute()
          await trx
            .insertInto('memberships')
            .values({
              id: makeId('membership'),
              user_id: minted.userId,
              team_id: teamId,
              role: 'member',
              is_player: true,
              jersey: String(i + 1),
              positions: i < POSITIONS.length ? [POSITIONS[i]] : []
            })
            .execute()
          roster[side].push(minted.userId)
        }

      const games: string[] = []
      for (let i = 0; i < count; i++) {
        const gameId = makeId('game')
        await trx
          .insertInto('games')
          .values({
            id: gameId,
            home_team_id: homeTeamId,
            away_team_id: awayTeamId,
            season_id: seasonId,
            start_at: new Date(Date.now() + i * 3600_000),
            venue: 'Scoring Field',
            status: 'scheduled'
          })
          .execute()
        games.push(gameId)
      }

      const normalised = email.trim().toLowerCase()
      const passwordHash = await hashPassword(password)
      const existing = await findUserByEmail(trx, normalised)
      let viewerId: number
      if (existing != null) {
        viewerId = existing.id
        await trx
          .updateTable('users')
          .set({
            password_hash: passwordHash,
            login_enabled: true,
            is_admin: false
          })
          .where('id', '=', viewerId)
          .execute()
      } else {
        const minted = mint()
        viewerId = minted.userId
        await trx
          .insertInto('users')
          .values({
            id: viewerId,
            legacyId: minted.legacyId,
            display_name: normalised.split('@')[0],
            password_hash: passwordHash,
            login_enabled: true,
            is_admin: false
          })
          .execute()
        await addEmail(trx, viewerId, normalised, {
          isPrimary: true,
          source: 'manual'
        })
      }
      await trx
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: viewerId,
          team_id: homeTeamId,
          role: 'member'
        })
        .execute()
      return { games, roster, viewerId }
    })
    for (const game of out.games) console.log(`GAME_ID=${game}`)
    console.log(`AWAY=${out.roster.away.slice(0, 9).join(',')}`)
    console.log(`HOME=${out.roster.home.slice(0, 9).join(',')}`)
    console.log(`VIEWER=${out.viewerId}`)
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/scoringGame.ts') || entry.endsWith('/scoringGame.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
