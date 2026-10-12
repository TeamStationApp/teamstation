import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GameIntent } from '../../common/gameApprovals'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('event metadata through game consent and revisions', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const game = (): GameIntent => ({
    homeTeamId: f.teamA,
    awayTeamId: f.teamB,
    seasonId: f.seasonA,
    startAt: '2027-04-10T18:00:00Z',
    endAt: '2027-04-10T20:00:00Z',
    address: '1 Demo Way',
    latitude: 0,
    longitude: 0,
    venue: 'Demo Field',
    outsideTournament: null,
    timezone: 'UTC',
    status: 'scheduled'
  })
  const send = async (
    fields: Record<string, unknown>,
    key: string
  ): Promise<{ id: string; proposedGameId: string; gameId: string }> => {
    const response = await f.h.request('POST', '/game-requests', {
      sender: { kind: 'team', id: f.teamA },
      idempotencyKey: key,
      ...fields
    })
    expect(response.status).equals(201)
    return await response.json()
  }
  const accept = async (id: string): Promise<{ gameId: string }> => {
    const response = await f.h.request(
      'POST',
      `/game-requests/${id}/accept`,
      undefined,
      102
    )
    expect(response.status).equals(200)
    return await response.json()
  }
  it('projects supplied details before consent and preserves them through publication and exact retry', async () => {
    const request = await send({ game: game() }, 'event-details-demo')
    const pending = await (await f.h.request('GET', '/events?when=all')).json()
    expect(
      pending.find((row: { id: string }) => row.id === request.proposedGameId)
    ).includes({
      address: '1 Demo Way',
      endAt: '2027-04-10T20:00:00.000Z',
      latitude: 0,
      longitude: 0
    })
    const accepted = await accept(request.id)
    const read = await (
      await f.h.request('GET', `/games/${accepted.gameId}`)
    ).json()
    expect(read).includes({
      address: '1 Demo Way',
      endAt: '2027-04-10T20:00:00.000Z',
      latitude: 0,
      longitude: 0
    })
    expect((await send({ game: game() }, 'event-details-demo')).id).equals(
      request.id
    )
    const state = await (
      await f.h.request('GET', `/games/${accepted.gameId}/scheduling`)
    ).json()
    expect(state.game).includes({
      address: '1 Demo Way',
      endAt: '2027-04-10T20:00:00.000Z'
    })
  })
  it('retains omitted location and duration when a legacy editor moves start time, and clears stale coordinates on an address edit', async () => {
    const request = await send({ game: game() }, 'event-details-create')
    const created = await accept(request.id)
    let state = await (
      await f.h.request('GET', `/games/${created.gameId}/scheduling`)
    ).json()
    const { endAt, address, latitude, longitude, ...legacyFields } = game()
    const legacy = { ...legacyFields, startAt: '2027-04-10T19:00:00Z' }
    const revision = await send(
      { game: legacy, gameId: created.gameId, expected: state.version },
      'legacy-event-edit'
    )
    await accept(revision.id)
    state = await (
      await f.h.request('GET', `/games/${created.gameId}/scheduling`)
    ).json()
    expect(state.game).includes({
      address: '1 Demo Way',
      endAt: '2027-04-10T21:00:00.000Z',
      latitude: 0
    })
    const changed = await send(
      {
        game: { ...legacy, address: '2 Demo Way', endAt: null },
        gameId: created.gameId,
        expected: state.version
      },
      'event-address-edit'
    )
    await accept(changed.id)
    const read = await (
      await f.h.request('GET', `/games/${created.gameId}`)
    ).json()
    expect(read).includes({
      address: '2 Demo Way',
      endAt: null,
      latitude: null,
      longitude: null
    })
  })
})
