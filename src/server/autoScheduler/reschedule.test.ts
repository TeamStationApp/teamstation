import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type {
  GameToReschedule,
  Publication,
  SchedulePreview
} from '../../common/schedulePreviews'
import { userIdOfGumbo } from '../../common/userId'
import { SEASON_A_SETTINGS } from '../../test/autoSchedulerFixture'
import { type SchedulerWorld, schedulerWorld } from '../../test/schedulerWorld'
import { listenScreenScopes } from '../../test/screenScopeNotices'

const DAY_MS = 24 * 60 * 60 * 1000

describe('rescheduling published games', function () {
  this.timeout(240000)
  let w: SchedulerWorld
  const listed = async (): Promise<GameToReschedule[]> => {
    const answer = await w.call<{ items: GameToReschedule[] }>(
      101,
      'GET',
      `/leagues/${w.fx.f.leagueA}/games-to-reschedule`
    )
    expect(answer.status).equals(200)
    return answer.body.items
  }
  const attention = async (): Promise<number> =>
    (
      await w.fx.f.h.db
        .selectFrom('notification_events')
        .select('recorded_recipients')
        .where('source_type', '=', 'scheduleNeedsAttention')
        .execute()
    ).filter(row => row.recorded_recipients.includes(userIdOfGumbo(101))).length
  const setVisitorsActive = async (active: boolean): Promise<void> => {
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
  }
  /**
   * Builds around the existing games and publishes Option 1. With
   * `waiting`, the Visitors stop competing first, so their games wait for
   * their admin's approval.
   */
  const published = async (waiting: boolean): Promise<SchedulePreview> => {
    const built = await w.call<SchedulePreview>(
      101,
      'POST',
      `/leagues/${w.fx.f.leagueA}/schedule-previews`,
      { mode: 'full', existing: 'workAround' }
    )
    expect(built.status).equals(201)
    if (waiting) await setVisitorsActive(false)
    const result = await w.call<Publication>(
      101,
      'POST',
      `/schedule-previews/${built.body.id}/publications`,
      { option: 0 }
    )
    expect(result.status).equals(200)
    return result.body.preview
  }
  const rows = async (
    previewId: string
  ): Promise<
    Array<{
      game_key: string
      request_id: string | null
      game_id: string | null
      home_team_id: string
      away_team_id: string
      season_id: string
    }>
  > =>
    await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select([
        'game_key',
        'request_id',
        'game_id',
        'home_team_id',
        'away_team_id',
        'season_id'
      ])
      .where('preview_id', '=', previewId)
      .orderBy('game_key')
      .execute()
  const isExhibition = async (requestId: string): Promise<boolean> =>
    (
      (
        await w.fx.f.h.db
          .selectFrom('group_requests')
          .select('terms')
          .where('id', '=', requestId)
          .executeTakeFirstOrThrow()
      ).terms as { game: { exhibition?: boolean } }
    ).game.exhibition === true
  beforeEach(async () => {
    w = await schedulerWorld()
  })
  afterEach(async () => {
    await w?.close()
  })

  it('lists declined, withdrawn and expired proposals, telling the league’s admins of the first two', async () => {
    const preview = await published(true)
    const waiting = (await rows(preview.id)).filter(row => row.game_id == null)
    expect(waiting.length).equals(5)
    expect(await listed()).deep.equals([])
    expect(
      (
        await w.call(
          103,
          'POST',
          `/game-requests/${waiting[0].request_id}/decline`
        )
      ).status
    ).equals(200)
    expect((await listed()).map(game => game.reason)).deep.equals(['declined'])
    expect(await attention()).equals(1)
    const notice = await w.fx.f.h.db
      .selectFrom('notification_events')
      .select('metadata')
      .where('source_type', '=', 'scheduleNeedsAttention')
      .executeTakeFirstOrThrow()
    expect(notice.metadata).include({
      title: 'A scheduled game needs rescheduling',
      leagueId: w.fx.f.leagueA
    })
    expect((notice.metadata as { description: string }).description).matches(
      /^Demo \w+ at Demo \w+ was declined \(.+ E[DS]T\)\. Open the Auto-Scheduler to recalculate\.$/
    )
    expect(
      (
        await w.call(
          101,
          'POST',
          `/game-requests/${waiting[1].request_id}/withdraw`
        )
      ).status
    ).equals(200)
    expect((await listed()).map(game => game.reason).sort()).deep.equals([
      'declined',
      'withdrawn'
    ])
    expect(await attention()).equals(2)
    w.fx.f.advance(8 * DAY_MS)
    const later = await listed()
    expect(later.map(game => game.reason).sort()).deep.equals([
      'declined',
      'expired',
      'expired',
      'expired',
      'withdrawn'
    ])
    expect(later[0]).include({ previewId: preview.id })
    expect(later[0].homeTeamName).not.equals('')
    // Expiry is read, not announced.
    expect(await attention()).equals(2)
  })

  it('lists a rainout and a team’s withdrawal from published games', async () => {
    const preview = await published(false)
    // The league's admin withdraws the second game's home team, so that is
    // one of the league's own teams, not the Visitors.
    const scheduled = (await rows(preview.id)).filter(
      row => row.game_id != null
    )
    const second = scheduled.find(
      row => row.home_team_id !== w.fx.teams.Visitors
    )!
    const first = scheduled.find(row => row !== second)!
    const scheduling = await w.call<{
      game: Record<string, unknown>
      version: string
    }>(101, 'GET', `/games/${first.game_id}/scheduling`)
    expect(scheduling.status).equals(200)
    const rainout = await w.call(101, 'POST', '/game-requests', {
      sender: { kind: 'season', id: w.fx.f.seasonA },
      gameId: first.game_id,
      expected: scheduling.body.version,
      game: { ...scheduling.body.game, status: 'cancelled' },
      idempotencyKey: 'rainout-one'
    })
    expect(rainout.status).equals(201)
    expect(
      (await listed()).map(game => [game.gameId, game.reason])
    ).deep.equals([[first.game_id, 'cancelled']])
    expect(await attention()).equals(1)
    expect(
      (
        await w.call(101, 'POST', `/games/${second.game_id}/withdrawals`, {
          teamId: second.home_team_id
        })
      ).status
    ).equals(200)
    expect((await listed()).map(game => game.reason).sort()).deep.equals([
      'cancelled',
      'teamWithdrew'
    ])
    expect(await attention()).equals(2)
  })

  it('cancels a change that drops the outside team as a replacement, and lists it', async () => {
    const preview = await published(false)
    const visitors = (await rows(preview.id)).find(
      row =>
        row.game_id != null &&
        (row.home_team_id === w.fx.teams.Visitors ||
          row.away_team_id === w.fx.teams.Visitors)
    )!
    const scheduling = await w.call<{
      game: { homeTeamId: string; awayTeamId: string }
      version: string
    }>(101, 'GET', `/games/${visitors.game_id}/scheduling`)
    const game = { ...scheduling.body.game }
    if (game.homeTeamId === w.fx.teams.Visitors)
      game.homeTeamId = w.fx.teams.Rockets
    else game.awayTeamId = w.fx.teams.Rockets
    if (game.homeTeamId === game.awayTeamId) game.awayTeamId = w.fx.teams.Foxes
    const changed = await w.call(101, 'POST', '/game-requests', {
      sender: { kind: 'season', id: w.fx.f.seasonA },
      gameId: visitors.game_id,
      expected: scheduling.body.version,
      game,
      idempotencyKey: 'drop-visitors'
    })
    expect(changed.status).equals(201)
    const old = await w.fx.f.h.db
      .selectFrom('games')
      .select('cancellation_reason')
      .where('id', '=', visitors.game_id!)
      .executeTakeFirstOrThrow()
    expect(old.cancellation_reason).equals('replacement')
    expect((await listed()).map(item => item.gameId)).deep.equals([
      visitors.game_id
    ])
    expect(await attention()).equals(1)
  })

  it('refuses to reject a published game a later build already replaced', async () => {
    const preview = await published(false)
    const scheduled = (await rows(preview.id)).find(row => row.game_id != null)!
    // A later Replace build cancels it to place it again.
    await w.fx.f.h.db
      .updateTable('games')
      .set({ status: 'cancelled', cancellation_reason: 'rescheduled' })
      .where('id', '=', scheduled.game_id!)
      .execute()
    const refused = await w.call<SchedulePreview>(
      101,
      'PUT',
      `/schedule-previews/${preview.id}`,
      { option: 0, rejectedGameKeys: [scheduled.game_key] }
    )
    expect(refused.status).equals(409)
    const read = await w.call<SchedulePreview>(
      101,
      'GET',
      `/schedule-previews/${preview.id}`
    )
    expect(
      read.body.published.find(game => game.gameKey === scheduled.game_key)
        ?.state
    ).equals('resolved')
    expect(await listed()).deep.equals([])
  })

  it('rejects published games: a scheduled one leaves the schedules for good, a waiting one is withdrawn', async () => {
    const preview = await published(true)
    const all = await rows(preview.id)
    const scheduled = all.find(row => row.game_id != null)!
    const waiting = all.find(row => row.game_id == null)!
    const before = await attention()
    const notices = await listenScreenScopes(w.fx.f.h.db)
    const mark = notices.mark()
    const edited = await w.call<SchedulePreview>(
      101,
      'PUT',
      `/schedule-previews/${preview.id}`,
      { option: 0, rejectedGameKeys: [scheduled.game_key, waiting.game_key] }
    )
    expect(edited.status).equals(200)
    // Open screens of its teams and season are told it left them.
    try {
      for (const ids of [
        { gameId: scheduled.game_id! },
        { teamId: scheduled.home_team_id },
        { teamId: scheduled.away_team_id },
        { seasonId: scheduled.season_id }
      ])
        await notices.named(mark, ids)
    } finally {
      await notices.close()
    }
    const states = new Map(
      edited.body.published.map(game => [game.gameKey, game.state])
    )
    expect(states.get(scheduled.game_key)).equals('rejected')
    expect(states.get(waiting.game_key)).equals('rejected')
    const game = await w.fx.f.h.db
      .selectFrom('games')
      .select(['status', 'cancellation_reason'])
      .where('id', '=', scheduled.game_id!)
      .executeTakeFirstOrThrow()
    expect(game).deep.equals({
      status: 'cancelled',
      cancellation_reason: 'rescheduled'
    })
    const request = await w.fx.f.h.db
      .selectFrom('group_requests')
      .select('status')
      .where('id', '=', waiting.request_id!)
      .executeTakeFirstOrThrow()
    expect(request.status).equals('cancelled')
    expect((await listed()).map(item => item.reason)).deep.equals([
      'rejected',
      'rejected'
    ])
    // Rejecting is the admin's own doing: no word back to the admin.
    expect(await attention()).equals(before)
    const removed = await w.fx.f.h.db
      .selectFrom('notification_events')
      .select('metadata')
      .where('source_type', '=', 'schedulePublished')
      .execute()
    expect(
      removed.some(row =>
        (row.metadata as { description: string }).description.includes(
          '1 earlier game removed'
        )
      )
    ).equals(true)
    // A rescheduled game can't be brought back.
    const scheduling = await w.call<{
      canPropose: boolean
      game: Record<string, unknown>
      version: string
    }>(101, 'GET', `/games/${scheduled.game_id}/scheduling`)
    expect(scheduling.body.canPropose).equals(false)
    const restore = await w.call(101, 'POST', '/game-requests', {
      sender: { kind: 'season', id: w.fx.f.seasonA },
      gameId: scheduled.game_id,
      expected: scheduling.body.version,
      game: { ...scheduling.body.game, status: 'scheduled' },
      idempotencyKey: 'restore-rescheduled'
    })
    expect(restore.status, JSON.stringify(restore.body)).equals(409)
    const withdrawal = await w.call<{ reason: string }>(
      101,
      'POST',
      `/games/${scheduled.game_id}/withdrawals`,
      { teamId: scheduled.home_team_id }
    )
    expect(withdrawal.body.reason).equals('rescheduled')
    // The season's schedule leaves it out.
    const events = await w.call<Array<{ id: string }>>(
      101,
      'GET',
      `/teams/${scheduled.home_team_id}/games`
    )
    expect(events.body.map(item => item.id)).not.includes(scheduled.game_id)
  })

  it('recalculates just the listed teams, counting their waiting games, and resolves them on publishing', async () => {
    const preview = await published(true)
    const waiting = (await rows(preview.id)).filter(row => row.game_id == null)
    let declined: (typeof waiting)[number] | undefined
    for (const row of waiting)
      if (!(await isExhibition(row.request_id!))) {
        declined = row
        break
      }
    expect(declined).not.equals(undefined)
    await w.call(103, 'POST', `/game-requests/${declined!.request_id}/decline`)
    await setVisitorsActive(true)
    const teamIds = [declined!.home_team_id, declined!.away_team_id]
    const partial = await w.call<SchedulePreview>(
      101,
      'POST',
      `/leagues/${w.fx.f.leagueA}/schedule-previews`,
      { mode: 'partial', existing: 'replace', teamIds }
    )
    expect(partial.status).equals(201)
    const option = partial.body.options[0]
    expect(option.games.length).equals(1)
    // The listed game itself, placed away from where it was declined.
    const before = preview.options[0].games.find(
      game => game.key === declined!.game_key
    )!
    expect(option.games[0].key).equals(
      `listed:${preview.id}:${declined!.game_key}`
    )
    expect(option.games[0].startAt).not.equals(before.startAt)
    for (const game of option.games)
      expect(teamIds).include.members([game.homeTeamId, game.awayTeamId])
    // The Visitors' other waiting games count toward their total.
    const visitors = option.fairness.find(
      row => row.teamId === w.fx.teams.Visitors
    )!
    expect(visitors.regularGames).equals(4)
    const result = await w.call<Publication>(
      101,
      'POST',
      `/schedule-previews/${partial.body.id}/publications`,
      { option: 0 }
    )
    expect(result.status).equals(200)
    expect(await listed()).deep.equals([])
    // Their other waiting proposals are left as they were.
    const others = await w.fx.f.h.db
      .selectFrom('group_requests')
      .select('status')
      .where(
        'id',
        'in',
        waiting
          .filter(row => row.request_id !== declined!.request_id)
          .map(row => row.request_id!)
      )
      .execute()
    expect(others.every(row => row.status === 'pending')).equals(true)
  })

  it('resends a declined proposal with its preview, so accepting it links the game', async () => {
    const preview = await published(true)
    const [first] = (await rows(preview.id)).filter(row => row.game_id == null)
    await w.call(103, 'POST', `/game-requests/${first.request_id}/decline`)
    expect(await attention()).equals(1)
    const resent = await w.call<{ id: string }>(
      101,
      'POST',
      `/game-requests/${first.request_id}/resend`,
      { idempotencyKey: 'resend-one' }
    )
    expect(resent.status).equals(201)
    const row = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select('request_id')
      .where('preview_id', '=', preview.id)
      .where('game_key', '=', first.game_key)
      .executeTakeFirstOrThrow()
    expect(row.request_id).equals(resent.body.id)
    expect(await listed()).deep.equals([])
    expect(await attention()).equals(1)
    const accepted = await w.call<{ gameId: string }>(
      103,
      'POST',
      `/game-requests/${resent.body.id}/accept`
    )
    expect(accepted.status).equals(200)
    const game = await w.fx.f.h.db
      .selectFrom('games')
      .select('schedule_preview_id')
      .where('id', '=', accepted.body.gameId)
      .executeTakeFirstOrThrow()
    expect(game.schedule_preview_id).equals(preview.id)
  })

  it('resolves a listed game rejected from the recalculation and added back by hand', async () => {
    const preview = await published(true)
    const waiting = (await rows(preview.id)).filter(row => row.game_id == null)
    let declined: (typeof waiting)[number] | undefined
    for (const row of waiting)
      if (!(await isExhibition(row.request_id!))) {
        declined = row
        break
      }
    await w.call(103, 'POST', `/game-requests/${declined!.request_id}/decline`)
    await setVisitorsActive(true)
    const partial = await w.call<SchedulePreview>(
      101,
      'POST',
      `/leagues/${w.fx.f.leagueA}/schedule-previews`,
      {
        mode: 'partial',
        existing: 'replace',
        teamIds: [declined!.home_team_id, declined!.away_team_id]
      }
    )
    const placed = partial.body.options[0].games[0]
    expect(placed.key).equals(`listed:${preview.id}:${declined!.game_key}`)
    // Rejected, then added back by hand in the same slot.
    const { key: _key, ...game } = placed
    const edited = await w.call<SchedulePreview>(
      101,
      'PUT',
      `/schedule-previews/${partial.body.id}`,
      { option: 0, rejectedGameKeys: [placed.key], addedGames: [game] }
    )
    expect(edited.status).equals(200)
    const result = await w.call<Publication>(
      101,
      'POST',
      `/schedule-previews/${partial.body.id}/publications`,
      { option: 0 }
    )
    expect(result.body.scheduled).equals(1)
    expect(await listed()).deep.equals([])
  })

  it('keeps a listed game listed when its re-placement is rejected, though the build moves another game of the same teams', async () => {
    await w.call(101, 'PUT', `/seasons/${w.fx.f.seasonA}/schedule-settings`, {
      ...SEASON_A_SETTINGS,
      regularGames: 12
    })
    const built = await w.call<SchedulePreview>(
      101,
      'POST',
      `/leagues/${w.fx.f.leagueA}/schedule-previews`,
      { mode: 'full', existing: 'replace' }
    )
    expect(built.status).equals(201)
    await w.call(
      101,
      'POST',
      `/schedule-previews/${built.body.id}/publications`,
      {
        option: 0
      }
    )
    const bears = w.fx.teams.Bears
    const owls = w.fx.teams.Owls
    const theirs = (await rows(built.body.id)).filter(
      row =>
        row.game_id != null &&
        [row.home_team_id, row.away_team_id].sort().join() ===
          [bears, owls].sort().join()
    )
    expect(theirs.length).equals(2)
    const scheduling = await w.call<{
      game: Record<string, unknown>
      version: string
    }>(101, 'GET', `/games/${theirs[0].game_id}/scheduling`)
    await w.call(101, 'POST', '/game-requests', {
      sender: { kind: 'season', id: w.fx.f.seasonA },
      gameId: theirs[0].game_id,
      expected: scheduling.body.version,
      game: { ...scheduling.body.game, status: 'cancelled' },
      idempotencyKey: 'rainout-bears-owls'
    })
    expect((await listed()).length).equals(1)
    const partial = await w.call<SchedulePreview>(
      101,
      'POST',
      `/leagues/${w.fx.f.leagueA}/schedule-previews`,
      { mode: 'partial', existing: 'replace', teamIds: [bears, owls] }
    )
    const option = partial.body.options[0]
    const placed = option.games.find(game => game.key.startsWith('listed:'))!
    expect(option.games.some(game => game.key.startsWith('replaced:'))).equals(
      true
    )
    await w.call(101, 'PUT', `/schedule-previews/${partial.body.id}`, {
      option: 0,
      rejectedGameKeys: [placed.key]
    })
    await w.call(
      101,
      'POST',
      `/schedule-previews/${partial.body.id}/publications`,
      { option: 0 }
    )
    expect((await listed()).map(game => game.reason)).deep.equals(['cancelled'])
  })
})
