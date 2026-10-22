import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type {
  Publication,
  SchedulePreview
} from '../../common/schedulePreviews'
import { G1 } from '../../test/autoSchedulerFixture'
import { type SchedulerWorld, schedulerWorld } from '../../test/schedulerWorld'

describe('publishing a schedule preview', function () {
  this.timeout(240000)
  let w: SchedulerWorld
  const build = async (
    body: unknown,
    user = 101
  ): Promise<{ status: number; body: SchedulePreview }> =>
    await w.call<SchedulePreview>(
      user,
      'POST',
      `/leagues/${w.fx.f.leagueA}/schedule-previews`,
      body
    )
  const publish = async (
    previewId: string,
    option = 0,
    user = 101
  ): Promise<{ status: number; body: Publication }> =>
    await w.call<Publication>(
      user,
      'POST',
      `/schedule-previews/${previewId}/publications`,
      { option }
    )
  const participants = (): string[] =>
    ['Hawks', 'Owls', 'Foxes', 'Comets', 'Bears', 'Rockets', 'Visitors'].map(
      name => w.fx.teams[name]
    )
  beforeEach(async () => {
    w = await schedulerWorld()
  })
  afterEach(async () => {
    await w?.close()
  })

  it('asks about existing games, works around them, and publishes every game at once', async () => {
    const asked = await build({ mode: 'full' })
    expect(asked.status).equals(409)
    expect((asked.body as unknown as { details: unknown }).details).deep.equals(
      { existingGames: 2 }
    )
    const built = await build({ mode: 'full', existing: 'workAround' })
    expect(built.status).equals(201)
    const preview = built.body
    expect(preview).include({
      status: 'open',
      existing: 'workAround',
      replacing: 0,
      blocking: null
    })
    expect(preview.options.length).within(1, 3)
    const [best] = preview.options
    // Everyone gets the same counts, the fixed G1 and noon game included,
    // and the exhibition teams split 4 and 3.
    for (const id of participants()) {
      const row = best.fairness.find(item => item.teamId === id)!
      expect([row.regularGames, row.exhibitionGames], id).deep.equals([4, 1])
    }
    expect(
      best.fairness
        .filter(row => row.exhibitionTeam)
        .map(row => row.exhibitionGames)
        .sort((a, b) => a - b)
    ).deep.equals([3, 4])
    expect(best.games.length).equals(12 + 7)
    // No game overlaps the fixed ones on Field 1.
    const fixed = await w.fx.f.h.db
      .selectFrom('games')
      .select(['start_at', 'end_at'])
      .where('field_id', '=', w.fieldId)
      .execute()
    for (const game of best.games)
      for (const held of fixed)
        expect(
          Date.parse(game.startAt) < held.end_at!.getTime() &&
            held.start_at.getTime() < Date.parse(game.endAt),
          game.key
        ).equals(false)
    const published = await publish(preview.id)
    expect(published.status).equals(200)
    expect(published.body).include({ scheduled: 19, awaiting: 0, removed: 0 })
    expect(published.body.preview.status).equals('published')
    const games = await w.fx.f.h.db
      .selectFrom('games')
      .select(['status', 'field_id', 'field_size', 'venue'])
      .where('schedule_preview_id', '=', preview.id)
      .execute()
    expect(games.length).equals(19)
    for (const game of games)
      expect(game).deep.equals({
        status: 'scheduled',
        field_id: w.fieldId,
        field_size: '50/70',
        venue: 'Example Park'
      })
    const notices = await w.fx.f.h.db
      .selectFrom('notification_events')
      .select(['metadata'])
      .where('source_type', '=', 'schedulePublished')
      .execute()
    expect(notices.length).equals(9)
    expect(
      notices
        .map(row => row.metadata as { title: string; description: string })
        .find(item => item.title.endsWith('Demo Visitors'))
    ).include({
      title: 'Demo Regular schedule updated for Demo Visitors',
      description: '5 games scheduled.'
    })
    // A retry, by another league admin, publishes nothing more.
    const again = await publish(preview.id, 0, 105)
    expect(again.status).equals(200)
    expect(again.body).include({ scheduled: 19, awaiting: 0 })
    expect(
      (
        await w.fx.f.h.db
          .selectFrom('schedule_preview_games')
          .select('game_key')
          .where('preview_id', '=', preview.id)
          .execute()
      ).length
    ).equals(19)
    const read = await w.call<SchedulePreview>(
      101,
      'GET',
      `/schedule-previews/${preview.id}`
    )
    expect(
      read.body.published.every(game => game.state === 'scheduled')
    ).equals(true)
  })

  it('replaces the league’s upcoming games, reusing their time, and they leave the schedules', async () => {
    const built = await build({ mode: 'full', existing: 'replace' })
    expect(built.status).equals(201)
    expect(built.body.replacing).equals(2)
    const best = built.body.options[0]
    expect(best.games.length).equals(14 + 7)
    const published = await publish(built.body.id)
    expect(published.body).include({ scheduled: 21, removed: 2 })
    const g1 = await w.fx.f.h.db
      .selectFrom('games')
      .select(['status', 'cancellation_reason'])
      .where('id', '=', G1)
      .executeTakeFirstOrThrow()
    expect(g1).deep.equals({
      status: 'cancelled',
      cancellation_reason: 'rescheduled'
    })
    const owls = await w.call<Array<{ id: string }>>(
      101,
      'GET',
      `/teams/${w.fx.teams.Owls}/games`
    )
    expect(owls.status).equals(200)
    expect(owls.body.map(game => game.id)).not.includes(G1)
    const removed = await w.fx.f.h.db
      .selectFrom('notification_events')
      .select('metadata')
      .where('source_type', '=', 'schedulePublished')
      .execute()
    const owlsNotice = removed.find(
      row => (row.metadata as { teamId?: string }).teamId === w.fx.teams.Owls
    )
    expect(
      (owlsNotice?.metadata as { description: string }).description
    ).includes('1 earlier game removed')
  })

  it('refuses a build whose counted waiting proposal was declined since, and keeps the game listed', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    expect((await publish(first.body.id)).body.awaiting).equals(5)
    const next = await build({ mode: 'full', existing: 'workAround' })
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select(['request_id', 'game_key'])
      .where('preview_id', '=', first.body.id)
      .where('game_id', 'is', null)
      .executeTakeFirstOrThrow()
    expect(
      (
        await w.call(
          103,
          'POST',
          `/game-requests/${waiting.request_id}/decline`
        )
      ).status
    ).equals(200)
    const refused = await publish(next.body.id)
    expect(refused.status).equals(409)
    expect(
      JSON.stringify((refused.body as unknown as { details: unknown }).details)
    ).includes('counted on was canceled, declined or withdrawn')
    // Still waiting to be placed again.
    const listed = await w.call<{ items: Array<{ gameKey: string }> }>(
      101,
      'GET',
      `/leagues/${w.fx.f.leagueA}/games-to-reschedule`
    )
    expect(listed.body.items.map(item => item.gameKey)).includes(
      waiting.game_key
    )
  })

  it('keeps a game listed after the build listed when a recalculation of that build is published', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    expect((await publish(first.body.id)).body.awaiting).equals(5)
    // Replacing the scheduled games, it counts the waiting ones.
    const next = await build({ mode: 'full', existing: 'replace' })
    expect(next.body.options[0].games.length).greaterThan(0)
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select(['request_id', 'game_key'])
      .where('preview_id', '=', first.body.id)
      .where('game_id', 'is', null)
      .executeTakeFirstOrThrow()
    await w.call(103, 'POST', `/game-requests/${waiting.request_id}/decline`)
    // One game rejected and placed again: nothing places the declined one.
    await w.call(101, 'PUT', `/schedule-previews/${next.body.id}`, {
      option: 0,
      rejectedGameKeys: [next.body.options[0].games[0].key]
    })
    const again = await build({
      mode: 'partial',
      fromPreviewId: next.body.id,
      option: 0
    })
    expect(again.status).equals(201)
    expect((await publish(again.body.id)).status).equals(200)
    const listed = await w.call<{ items: Array<{ gameKey: string }> }>(
      101,
      'GET',
      `/leagues/${w.fx.f.leagueA}/games-to-reschedule`
    )
    expect(listed.body.items.map(item => item.gameKey)).includes(
      waiting.game_key
    )
  })

  it('refuses a second open preview of the league once another is published, naming its waiting games too', async () => {
    const one = await build({ mode: 'full', existing: 'workAround' })
    const two = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    const published = await publish(one.body.id)
    expect(published.body).include({ scheduled: 14, awaiting: 5 })
    const refused = await publish(two.body.id)
    expect(refused.status).equals(409)
    const stale = (
      refused.body as unknown as {
        details: { stale: Array<{ gameKey: string; problem: string }> }
      }
    ).details.stale
    // The proposals still waiting count as much as the games scheduled.
    expect(
      stale.filter(item => item.problem.startsWith('A game was proposed'))
        .length
    ).equals(5)
  })

  it('holds the time a pending change to a counted game proposes, and publishes', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    expect((await publish(first.body.id)).status).equals(200)
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    const visitors = await w.fx.f.h.db
      .selectFrom('games')
      .select('id')
      .where('schedule_preview_id', '=', first.body.id)
      .where(eb =>
        eb.or([
          eb('home_team_id', '=', w.fx.teams.Visitors),
          eb('away_team_id', '=', w.fx.teams.Visitors)
        ])
      )
      .executeTakeFirstOrThrow()
    const current = await w.call<{
      version: string
      game: { startAt: string; endAt: string }
    }>(101, 'GET', `/games/${visitors.id}/scheduling`)
    // Moved a day later, it waits for the Visitors' admin.
    const later = (at: string): string =>
      new Date(Date.parse(at) + 24 * 60 * 60 * 1000).toISOString()
    const startAt = later(current.body.game.startAt)
    const sent = await w.call<{ status: string }>(
      101,
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: w.fx.f.seasonA },
        gameId: visitors.id,
        expected: current.body.version,
        game: {
          ...current.body.game,
          startAt,
          endAt: later(current.body.game.endAt)
        },
        idempotencyKey: 'pending-change'
      }
    )
    expect(sent.body.status).equals('pending')
    const next = await build({ mode: 'full', existing: 'workAround' })
    expect(next.status).equals(201)
    const stored = await w.fx.f.h.db
      .selectFrom('schedule_previews')
      .select('input')
      .where('id', '=', next.body.id)
      .executeTakeFirstOrThrow()
    const input = stored.input as {
      engine: { bookings: Array<{ key: string; start: number }> }
    }
    expect(
      input.engine.bookings.find(
        booking => booking.key === `pending:${visitors.id}`
      )?.start
    ).equals(Date.parse(startAt))
    expect((await publish(next.body.id)).status).equals(200)
  })

  it('refuses a Replace build once a game it replaces was played, and answers the count it stored', async () => {
    const built = await build({ mode: 'full', existing: 'replace' })
    expect(built.body.replacing).equals(2)
    const played = async (status: 'final' | 'scheduled'): Promise<void> => {
      await w.fx.f.h.db
        .updateTable('games')
        .set({ status })
        .where('id', '=', G1)
        .execute()
    }
    await played('final')
    const refused = await publish(built.body.id)
    expect(refused.status).equals(409)
    expect(
      JSON.stringify((refused.body as unknown as { details: unknown }).details)
    ).includes('A game this preview replaces was played, canceled or moved')
    await played('scheduled')
    const published = await publish(built.body.id)
    expect(published.status).equals(200)
    expect(published.body.removed).equals(2)
    // Asked again, it answers the same.
    expect((await publish(built.body.id)).body.removed).equals(2)
  })

  it('refuses an option whose games’ time has passed since the build', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const [first] = built.body.options[0].games
    w.fx.f.advance(Date.parse(first.startAt) - Date.now() + 60 * 1000)
    const refused = await publish(built.body.id)
    expect(refused.status).equals(409)
    const stale = (
      refused.body as unknown as {
        details: { stale: Array<{ gameKey: string; problem: string }> }
      }
    ).details.stale
    expect(stale).to.deep.include({
      gameKey: first.key,
      problem: 'This game’s time has passed.'
    })
  })

  it('serializes two publishes of one preview', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const [one, two] = await Promise.all([
      publish(built.body.id),
      publish(built.body.id, 0, 105)
    ])
    expect([one.status, two.status]).deep.equals([200, 200])
    expect(
      (
        await w.fx.f.h.db
          .selectFrom('games')
          .select('id')
          .where('schedule_preview_id', '=', built.body.id)
          .execute()
      ).length
    ).equals(19)
  })

  it('answers 409 when a field booking, a new game or a merged team changed things since the build', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const first = built.body.options[0].games[0]
    // Another league's game on the field, at the first game's time.
    await w.fx.f.h.db
      .insertInto('games')
      .values({
        id: 'gam_elsewhere',
        home_team_id: w.fx.f.teamB,
        away_team_id: w.fx.f.standaloneTeam,
        start_at: new Date(first.startAt),
        end_at: new Date(first.endAt),
        status: 'scheduled',
        field_id: w.fieldId,
        field_size: '50/70'
      })
      .execute()
    const stale = await publish(built.body.id)
    expect(stale.status).equals(409)
    expect(
      (
        stale.body as unknown as {
          details: { stale: Array<{ gameKey: string }> }
        }
      ).details.stale.map(item => item.gameKey)
    ).includes(first.key)
    await w.fx.f.h.db
      .deleteFrom('games')
      .where('id', '=', 'gam_elsewhere')
      .execute()
    // A new game in the season.
    await w.fx.f.h.db
      .insertInto('games')
      .values({
        id: 'gam_new',
        home_team_id: w.fx.teams.Foxes,
        away_team_id: w.fx.teams.Rockets,
        season_id: w.fx.f.seasonA,
        start_at: new Date('2027-07-30T12:00:00.000Z'),
        status: 'scheduled'
      })
      .execute()
    expect((await publish(built.body.id)).status).equals(409)
    await w.fx.f.h.db.deleteFrom('games').where('id', '=', 'gam_new').execute()
    // A merged team.
    await w.fx.f.h.db
      .updateTable('teams')
      .set({ merged_into: w.fx.teams.Hawks })
      .where('id', '=', w.fx.teams.Rockets)
      .execute()
    expect((await publish(built.body.id)).status).equals(409)
    await w.fx.f.h.db
      .updateTable('teams')
      .set({ merged_into: null })
      .where('id', '=', w.fx.teams.Rockets)
      .execute()
    expect((await publish(built.body.id)).status).equals(200)
  })

  it('leaves a game waiting when the approval rules say so, and its acceptance links it to the preview', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    // The Visitors stop competing after the build, so their games need
    // their admin's approval.
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    const published = await publish(built.body.id)
    expect(published.status).equals(200)
    expect(published.body.awaiting).equals(5)
    expect(published.body.scheduled).equals(14)
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select(['request_id', 'game_id', 'game_key'])
      .where('preview_id', '=', built.body.id)
      .where('game_id', 'is', null)
      .execute()
    expect(waiting.length).equals(5)
    const request = await w.fx.f.h.db
      .selectFrom('group_requests')
      .select(['terms', 'status'])
      .where('id', '=', waiting[0].request_id!)
      .executeTakeFirstOrThrow()
    expect(request.status).equals('pending')
    expect(
      (request.terms as { schedulePreviewId?: string }).schedulePreviewId
    ).equals(built.body.id)
    const accepted = await w.call<{ gameId: string }>(
      103,
      'POST',
      `/game-requests/${waiting[0].request_id}/accept`
    )
    expect(accepted.status).equals(200)
    const game = await w.fx.f.h.db
      .selectFrom('games')
      .select('schedule_preview_id')
      .where('id', '=', accepted.body.gameId)
      .executeTakeFirstOrThrow()
    expect(game.schedule_preview_id).equals(built.body.id)
    const row = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select('game_id')
      .where('preview_id', '=', built.body.id)
      .where('game_key', '=', waiting[0].game_key)
      .executeTakeFirstOrThrow()
    expect(row.game_id).equals(accepted.body.gameId)
  })

  it('publishes a build that counted a waiting proposal accepted since', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    expect((await publish(first.body.id)).body.awaiting).equals(5)
    // The next build holds the waiting games' places and counts them.
    const next = await build({ mode: 'full', existing: 'workAround' })
    expect(next.status).equals(201)
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select('request_id')
      .where('preview_id', '=', first.body.id)
      .where('game_id', 'is', null)
      .executeTakeFirstOrThrow()
    expect(
      (await w.call(103, 'POST', `/game-requests/${waiting.request_id}/accept`))
        .status
    ).equals(200)
    // Its game is the one the build counted, not a new one.
    const published = await publish(next.body.id)
    expect(published.status).equals(200)
  })

  it('recalculates a Replace build without placing the replaced games again', async () => {
    const built = await build({ mode: 'full', existing: 'replace' })
    const option = built.body.options[0]
    expect(option.games.length).equals(14 + 7)
    const rejected = option.games[0]
    await w.call(101, 'PUT', `/schedule-previews/${built.body.id}`, {
      option: 0,
      rejectedGameKeys: [rejected.key]
    })
    const again = await build({
      mode: 'partial',
      fromPreviewId: built.body.id,
      option: 0
    })
    expect(again.status).equals(201)
    const next = again.body.options[0]
    expect(next.games.length).equals(option.games.length)
    expect(next.games.some(game => game.key.startsWith('replaced:'))).equals(
      false
    )
    for (const id of participants()) {
      const row = next.fairness.find(item => item.teamId === id)!
      expect([row.regularGames, row.exhibitionGames], id).deep.equals([4, 1])
    }
    const published = await publish(again.body.id)
    expect(published.body).include({ scheduled: 21, removed: 2 })
  })
})
