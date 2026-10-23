import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { PlannedGame } from '../../common/autoScheduler/types'
import {
  editedGames,
  type Publication,
  type SchedulePreview
} from '../../common/schedulePreviews'
import { fieldSizeLabel } from '../../common/venues'
import { type SchedulerWorld, schedulerWorld } from '../../test/schedulerWorld'

describe('schedule preview routes', function () {
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
  const edit = async (
    previewId: string,
    body: unknown,
    user = 101
  ): Promise<{ status: number; body: SchedulePreview }> =>
    await w.call<SchedulePreview>(
      user,
      'PUT',
      `/schedule-previews/${previewId}`,
      body
    )
  /** The added form of a planned game. */
  const adding = (game: PlannedGame): Omit<PlannedGame, 'key'> => {
    const { key: _key, ...rest } = game
    return rest
  }
  beforeEach(async () => {
    w = await schedulerWorld()
  })
  afterEach(async () => {
    await w?.close()
  })

  it('is for the league’s admins only, and checks what it is sent', async () => {
    expect((await build({ mode: 'full' }, 102)).status).equals(403)
    expect(
      (
        await w.call(
          102,
          'GET',
          `/leagues/${w.fx.f.leagueA}/games-to-reschedule`
        )
      ).status
    ).equals(403)
    for (const bad of [
      'full',
      { mode: 'some' },
      { mode: 'full', existing: 'keep' },
      { mode: 'full', teamIds: [w.fx.teams.Hawks] },
      { mode: 'partial' },
      { mode: 'partial', teamIds: [''] },
      { mode: 'partial', fromPreviewId: 'spv_x', option: 5 }
    ])
      expect((await build(bad)).status, JSON.stringify(bad)).equals(400)
    const built = await build({ mode: 'full', existing: 'workAround' })
    expect(built.status).equals(201)
    const id = built.body.id
    expect(
      (await w.call(102, 'GET', `/schedule-previews/${id}`)).status
    ).equals(403)
    expect((await edit(id, { option: 0 }, 102)).status).equals(403)
    expect(
      (
        await w.call(102, 'POST', `/schedule-previews/${id}/publications`, {
          option: 0
        })
      ).status
    ).equals(403)
    expect(
      (await w.call(101, 'POST', `/schedule-previews/${id}/publications`, {}))
        .status
    ).equals(400)
    expect(
      (
        await w.call(101, 'POST', `/schedule-previews/${id}/publications`, {
          option: 2.5
        })
      ).status
    ).equals(400)
    expect(
      (await w.call(101, 'GET', '/schedule-previews/spv_missing')).status
    ).equals(404)
    for (const bad of [
      'edits',
      { option: 7 },
      { option: 0, addedGames: 'one' },
      { option: 0, rejectedGameKeys: [7] },
      { option: 0, addedGames: [{}] },
      {
        option: 0,
        addedGames: [
          { ...adding(built.body.options[0].games[0]), size: '70/100' }
        ]
      },
      {
        option: 0,
        addedGames: [
          {
            ...adding(built.body.options[0].games[0]),
            awayTeamId: built.body.options[0].games[0].homeTeamId
          }
        ]
      },
      {
        option: 0,
        addedGames: [
          {
            ...adding(built.body.options[0].games[0]),
            endAt: built.body.options[0].games[0].startAt
          }
        ]
      },
      {
        option: 0,
        addedGames: [
          {
            ...adding(built.body.options[0].games[0]),
            startAt: '2027-04-10T14:02:00.000Z'
          }
        ]
      },
      { option: 0, rejectedGameKeys: ['not-a-game'] }
    ])
      expect((await edit(id, bad)).status, JSON.stringify(bad)).equals(400)
    // A run needs its seasons and fields.
    await w.call(101, 'PUT', `/leagues/${w.fx.f.leagueA}/schedule-setup`, {
      seasonIds: [],
      fieldIds: []
    })
    expect(
      (await build({ mode: 'full', existing: 'workAround' })).status
    ).equals(409)
  })

  it('rejects and adds games on an open preview, and recalculating keeps the rest', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const option = built.body.options[0]
    const [first, second] = option.games
    // Switching options starts that option's edits afresh.
    if (built.body.options.length > 1) {
      await edit(built.body.id, {
        option: 1,
        rejectedGameKeys: [built.body.options[1].games[0].key]
      })
      const switched = await edit(built.body.id, { option: 0 })
      expect(switched.body.edits).deep.equals({
        option: 0,
        rejectedGameKeys: [],
        addedGames: []
      })
    }
    // A game added where another already is breaks the rules.
    const clash = await edit(built.body.id, {
      option: 0,
      addedGames: [adding(second)]
    })
    expect(clash.status).equals(400)
    const rejected = await edit(built.body.id, {
      option: 0,
      rejectedGameKeys: [first.key]
    })
    expect(rejected.status).equals(200)
    expect(rejected.body.edits.rejectedGameKeys).deep.equals([first.key])
    // A game added in the freed slot, for one of the rejected game's teams
    // against a team free then, is allowed.
    const busy = (teamId: string): boolean =>
      option.games.some(
        game =>
          game.key !== first.key &&
          (game.homeTeamId === teamId || game.awayTeamId === teamId) &&
          game.startAt < first.endAt &&
          first.startAt < game.endAt
      )
    const partner = built.body.seasons[0].participants.find(
      id => id !== first.homeTeamId && id !== first.awayTeamId && !busy(id)
    )!
    const added = await edit(built.body.id, {
      option: 0,
      addedGames: [{ ...adding(first), awayTeamId: partner, exhibition: false }]
    })
    expect(added.status).equals(200)
    expect(added.body.edits.addedGames.length).equals(1)
    const addedKey = added.body.edits.addedGames[0].key
    // Rejecting another game, then recalculating, keeps everything else and
    // places both rejected matchups again, each away from its old slot, though
    // the added game already gives one of the first's teams a game.
    await edit(built.body.id, { option: 0, rejectedGameKeys: [second.key] })
    const again = await build({
      mode: 'partial',
      fromPreviewId: built.body.id,
      option: 0
    })
    expect(again.status).equals(201)
    // Still the full build it recalculated.
    expect(again.body.mode).equals('full')
    const next = again.body.options[0]
    const keptKeys = option.games
      .map(game => game.key)
      .filter(key => key !== first.key && key !== second.key)
    expect(next.games.map(game => game.key)).to.include.members([
      ...keptKeys,
      addedKey,
      first.key,
      second.key
    ])
    expect(next.games.length).equals(keptKeys.length + 3)
    expect(next.unmet).deep.equals([])
    for (const old of [first, second]) {
      const placed = next.games.find(game => game.key === old.key)!
      expect([placed.homeTeamId, placed.awayTeamId]).deep.equals([
        old.homeTeamId,
        old.awayTeamId
      ])
      expect(placed.startAt).not.equals(old.startAt)
    }
    // A kept game rejected frees its slot and teams for a game added there.
    const kept = next.games.find(game => keptKeys.includes(game.key))!
    await edit(again.body.id, { option: 0, rejectedGameKeys: [kept.key] })
    expect(
      (await edit(again.body.id, { option: 0, addedGames: [adding(kept)] }))
        .status
    ).equals(200)
    // The second game, placed again elsewhere, rejected and added back in
    // its old slot: only a marker of where not to place it was there.
    await edit(again.body.id, { option: 0, rejectedGameKeys: [second.key] })
    expect(
      (await edit(again.body.id, { option: 0, addedGames: [adding(second)] }))
        .status
    ).equals(200)
    // Publishing the recalculation publishes them all.
    const published = await w.call<Publication>(
      101,
      'POST',
      `/schedule-previews/${again.body.id}/publications`,
      { option: 0 }
    )
    expect(published.body.scheduled).equals(next.games.length)
    const old = await w.call<SchedulePreview>(
      101,
      'GET',
      `/schedule-previews/${built.body.id}`
    )
    expect(old.body.status).equals('discarded')
    expect((await edit(built.body.id, { option: 0 })).status).equals(409)
    expect(
      (
        await build({
          mode: 'partial',
          fromPreviewId: built.body.id,
          option: 0
        })
      ).status
    ).equals(409)
    expect(
      (
        await w.call(
          101,
          'POST',
          `/schedule-previews/${built.body.id}/publications`,
          {
            option: 0
          }
        )
      ).status
    ).equals(409)
    expect(addedKey).matches(/^added:/)
  })

  it('refuses an added game the engine could not have placed', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const [first] = built.body.options[0].games
    const season = built.body.seasons.find(each => each.id === first.seasonId)!
    await edit(built.body.id, { option: 0, rejectedGameKeys: [first.key] })
    const refusal = async (
      changes: Partial<PlannedGame>
    ): Promise<[number, string]> => {
      const answer = await edit(built.body.id, {
        option: 0,
        addedGames: [{ ...adding(first), ...changes }]
      })
      return [
        answer.status,
        String((answer.body as unknown as { message: string }).message)
      ]
    }
    expect(
      await refusal({
        startAt: '2020-05-02T14:00:00.000Z',
        endAt: '2020-05-02T15:30:00.000Z'
      })
    ).deep.equals([400, 'Choose a time still to come'])
    expect(
      await refusal({
        startAt: '2029-08-04T14:00:00.000Z',
        endAt: '2029-08-04T15:30:00.000Z'
      })
    ).deep.equals([400, `Choose a day within ${season.name}’s dates`])
    expect(
      await refusal({ size: first.size === '60/90' ? '46/60' : '60/90' })
    ).deep.equals([
      400,
      `${season.name} plays on ${fieldSizeLabel(first.size)} fields`
    ])
    expect(await refusal({ awayTeamId: 'tem_elsewhere' })).deep.equals([
      400,
      `Choose two of ${season.name}’s teams`
    ])
    // The rejected game itself can be added back.
    expect((await refusal({}))[0]).equals(200)
  })

  it('adds a game to a published preview by proposing it at once', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const option = built.body.options[0]
    const first = option.games[0]
    // Reject one game before publishing, then add its matchup back after.
    await edit(built.body.id, { option: 0, rejectedGameKeys: [first.key] })
    const published = await w.call<Publication>(
      101,
      'POST',
      `/schedule-previews/${built.body.id}/publications`,
      { option: 0 }
    )
    expect(published.body.scheduled).equals(option.games.length - 1)
    const added = await edit(built.body.id, {
      option: 0,
      addedGames: [adding(first)]
    })
    expect(added.status).equals(200)
    const states = added.body.published.filter(game =>
      game.gameKey.startsWith('added:')
    )
    expect(states.map(game => game.state)).deep.equals(['scheduled'])
    // The published option lists it with its own games.
    const listed = editedGames(
      added.body.options[0],
      added.body.edits,
      0
    ).filter(game => game.key.startsWith('added:'))
    expect(listed.map(game => game.key)).deep.equals(
      states.map(game => game.gameKey)
    )
    expect(listed[0]).include({
      homeTeamId: first.homeTeamId,
      awayTeamId: first.awayTeamId
    })
    // The same game again now clashes with the one just added.
    expect(
      (await edit(built.body.id, { option: 0, addedGames: [adding(first)] }))
        .status
    ).equals(400)
    // And it can be rejected there, which takes it off the schedules.
    const rejected = await edit(built.body.id, {
      option: 0,
      rejectedGameKeys: [listed[0].key]
    })
    expect(rejected.status).equals(200)
    expect(
      rejected.body.published.find(game => game.gameKey === listed[0].key)
        ?.state
    ).equals('rejected')
  })

  it('shows a blocking message, and no option, when no game fits', async () => {
    await w.call(101, 'PUT', `/venues/${w.venueId}/fields/${w.fieldId}`, {
      startsOn: '2027-03-06',
      endsOn: '2027-03-06',
      hours: [{ weekday: 6, start: '08:00', end: '09:00' }]
    })
    const built = await build({ mode: 'full', existing: 'workAround' })
    expect(built.status).equals(201)
    expect(built.body.options).deep.equals([])
    expect(built.body.blocking).equals(
      'not enough 50/70 field time to give every team 4 games'
    )
    expect(
      (
        await w.call(
          101,
          'POST',
          `/schedule-previews/${built.body.id}/publications`,
          {
            option: 0
          }
        )
      ).status
    ).equals(400)
  })
})
