import type { Kysely } from 'kysely'

import type { PlannedGame } from '../../common/autoScheduler/types'
import { badRequest, conflict } from '../../common/errors'
import { editedGames, type Publication } from '../../common/schedulePreviews'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import type { Clock } from '../groups/requests'
import { cancelAsRescheduled, noticeTeams, type Tallies } from './cancel'
import {
  currentHoldings,
  editsOf,
  holdingOf,
  optionsOf,
  previewFor,
  type PreviewRow,
  previewView,
  rescheduleKey,
  snapshotOf
} from './previews'
import { proposePlanned } from './propose'
import { gamesToReschedule } from './reschedule'
import { ruleProblem } from './rules'
import {
  pendingSchedulerProposals,
  type RescheduleRef,
  ruleContext,
  runGames,
  upcoming
} from './snapshot'

type Db = Kysely<Database>

/** One game that can no longer be published as it was built. */
interface Stale {
  gameKey: string
  problem: string
}

/**
 * Checks an option's games against what holds the fields and teams now,
 * leaving out the games the build replaces, and against each other; and
 * that what the build counted on is still there, with nothing new beside
 * it: no game scheduled or proposed by the Auto-Scheduler since, no
 * counted game or proposal gone, and every game it replaces still to come.
 * A game whose time has passed is stale as well.
 */
async function recheck(
  trx: Db,
  row: PreviewRow,
  games: PlannedGame[],
  clock: Clock
): Promise<Stale[]> {
  const snap = snapshotOf(row)
  const stale: Stale[] = []
  const now = clock.now()
  const seasonIds = snap.seasons.map(season => season.id)
  const fresh = (await runGames(trx, seasonIds)).filter(
    game => upcoming(game, now) && !snap.knownGameIds.includes(game.id)
  )
  for (const game of fresh)
    stale.push({
      gameKey: game.id,
      problem:
        'A game was scheduled in these seasons since this preview was built.'
    })
  const proposals = await pendingSchedulerProposals(trx, seasonIds, clock)
  for (const proposal of proposals)
    if (!snap.knownGameIds.includes(proposal.key))
      stale.push({
        gameKey: proposal.key,
        problem:
          'A game was proposed in these seasons since this preview was built.'
      })
  // The games it replaces must still be there to replace.
  if (snap.replaceGameIds.length > 0) {
    const standing = await trx
      .selectFrom('games')
      .select(['id', 'status', 'start_at'])
      .where('id', 'in', snap.replaceGameIds)
      .execute()
    for (const id of snap.replaceGameIds) {
      const game = standing.find(each => each.id === id)
      if (
        game?.status !== 'scheduled' ||
        game.start_at.getTime() <= now.getTime()
      )
        stale.push({
          gameKey: id,
          problem:
            'A game this preview replaces was played, canceled or moved since it was built.'
        })
    }
  }
  // The games and proposals the build counted (its kept games aside).
  const counted = snap.engine.fixed
    .map(game => game.key)
    .filter(key => !key.startsWith('kept:'))
  const standing = new Set([
    ...proposals.map(proposal => proposal.key),
    ...(counted.length === 0
      ? []
      : await trx
          .selectFrom('games')
          .select('id')
          .where('id', 'in', counted)
          .where('status', '!=', 'cancelled')
          .execute()
    ).map(game => game.id)
  ])
  for (const key of counted)
    if (!standing.has(key))
      stale.push({
        gameKey: key,
        problem:
          'A game this preview counted on was canceled, declined or withdrawn since it was built.'
      })
  const teamIds = [
    ...new Set(games.flatMap(game => [game.homeTeamId, game.awayTeamId]))
  ]
  const merged =
    teamIds.length === 0
      ? []
      : await trx
          .selectFrom('teams')
          .select('id')
          .where('id', 'in', teamIds)
          .where('merged_into', 'is not', null)
          .execute()
  for (const team of merged)
    stale.push({
      gameKey: team.id,
      problem: 'A team in this preview has since been merged into another.'
    })
  const holdings = await currentHoldings(trx, snap, clock, snap.replaceGameIds)
  const context = ruleContext(snap, [...holdings, ...games.map(holdingOf)])
  for (const game of games) {
    if (Date.parse(game.startAt) <= now.getTime()) {
      stale.push({ gameKey: game.key, problem: 'This game’s time has passed.' })
      continue
    }
    const problem = ruleProblem(
      {
        ...holdingOf(game),
        fieldId: game.fieldId,
        size: game.size,
        seasonId: game.seasonId
      },
      context
    )
    if (problem != null) stale.push({ gameKey: game.key, problem })
  }
  return stale
}

/** Two teams, either way round. */
function pairOf(homeTeamId: string, awayTeamId: string): string {
  return [homeTeamId, awayTeamId].sort().join('|')
}

/**
 * The listed games a publication places again: those whose own key it
 * placed first, then one more for each further game of the same two teams
 * that it places or an admin added, never a game it only moved.
 */
async function placedAgain(
  trx: Db,
  refs: RescheduleRef[],
  games: PlannedGame[]
): Promise<RescheduleRef[]> {
  if (refs.length === 0) return []
  const rows = await trx
    .selectFrom('schedule_preview_games')
    .select(['preview_id', 'game_key', 'home_team_id', 'away_team_id'])
    .where(eb =>
      eb.or(
        refs.map(ref =>
          eb.and([
            eb('preview_id', '=', ref.previewId),
            eb('game_key', '=', ref.gameKey)
          ])
        )
      )
    )
    .execute()
  // A game the same build only moved (`replaced:`) re-places nothing.
  const spare = new Map<string, number>()
  for (const game of games.filter(item => !item.key.startsWith('replaced:'))) {
    const pair = pairOf(game.homeTeamId, game.awayTeamId)
    spare.set(pair, (spare.get(pair) ?? 0) + 1)
  }
  const keys = new Set(games.map(game => game.key))
  const take = (pair: string): boolean => {
    const left = spare.get(pair) ?? 0
    if (left === 0) return false
    spare.set(pair, left - 1)
    return true
  }
  const ordered = [
    ...rows.filter(item =>
      keys.has(
        rescheduleKey({ previewId: item.preview_id, gameKey: item.game_key })
      )
    ),
    ...rows.filter(
      item =>
        !keys.has(
          rescheduleKey({ previewId: item.preview_id, gameKey: item.game_key })
        )
    )
  ]
  return ordered
    .filter(item => take(pairOf(item.home_team_id, item.away_team_id)))
    .map(item => ({ previewId: item.preview_id, gameKey: item.game_key }))
}

/**
 * Publishes one option of an open preview, once: it rechecks every game,
 * takes the replaced games off the schedules, proposes the option's games
 * as their seasons, resolves the listed games it placed again, and tells
 * each team's staff what happened to its games. A preview already
 * published answers with what it published.
 */
export async function publishPreview(
  db: Db,
  actor: Actor,
  previewId: string,
  optionIndex: number,
  clock: Clock
): Promise<Publication> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [`schedule-preview:${previewId}`])
    const row = await previewFor(trx, actor, previewId, { forUpdate: true })
    // One publication of the league at a time, so each sees the last.
    await lockKeys(trx, [`schedule-league:${row.league_id}`])
    const counts = async (): Promise<Publication> => {
      const current = await trx
        .selectFrom('schedule_previews')
        .selectAll()
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow()
      const preview = await previewView(trx, current, clock)
      return {
        preview,
        scheduled: preview.published.filter(game => game.state === 'scheduled')
          .length,
        awaiting: preview.published.filter(game => game.state === 'awaiting')
          .length,
        removed: current.removed_games ?? 0
      }
    }
    if (row.status === 'published') return await counts()
    if (row.status === 'discarded')
      throw conflict('This preview was replaced by a newer one')
    const option = optionsOf(row)[optionIndex]
    if (option == null) throw badRequest('Choose one of the preview’s options')
    const games = editedGames(option, editsOf(row), optionIndex)
    const stale = await recheck(trx, row, games, clock)
    if (stale.length > 0)
      throw conflict(
        'Something changed since this preview was built. Build it again.',
        { stale }
      )
    const snap = snapshotOf(row)
    const tallies: Tallies = new Map()
    // Only the games still scheduled are replaced; a rainout since is not.
    const removed = await cancelAsRescheduled(
      trx,
      snap.replaceGameIds,
      clock,
      actor.userId,
      tallies
    )
    await proposePlanned(trx, actor, row.id, snap, games, clock, tallies)
    // A full build places again every listed game of its seasons that it
    // was built with; one listed since stays listed. A partial build
    // resolves the listed games it places again: one listed game for each
    // game of the same two teams, whether the engine placed it or an admin
    // added it by hand.
    const builtWith = new Set(
      snap.reschedules.map(ref => `${ref.previewId}\u0000${ref.gameKey}`)
    )
    const resolve =
      row.mode === 'full'
        ? (await gamesToReschedule(trx, row.league_id, clock)).filter(
            game =>
              snap.seasons.some(season => season.id === game.seasonId) &&
              builtWith.has(`${game.previewId}\u0000${game.gameKey}`)
          )
        : await placedAgain(trx, snap.reschedules, games)
    for (const ref of resolve)
      await trx
        .updateTable('schedule_preview_games')
        .set({ resolved_at: clock.now() })
        .where('preview_id', '=', ref.previewId)
        .where('game_key', '=', ref.gameKey)
        .where('resolved_at', 'is', null)
        .execute()
    await trx
      .updateTable('schedule_previews')
      .set({
        status: 'published',
        published_option: optionIndex,
        published_at: clock.now(),
        removed_games: removed.length
      })
      .where('id', '=', row.id)
      .execute()
    await noticeTeams(trx, tallies, { actorId: actor.userId })
    return await counts()
  })
}
