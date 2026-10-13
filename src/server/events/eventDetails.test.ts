import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { asEventInfo } from '../../common/eventInfo'
import { migration058EventDetails } from '../../migrate/migrations/058eventDetails'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('event venue notes, arrival and classification storage', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const create = async (
    extra: Record<string, unknown> = {}
  ): Promise<string> => {
    const response = await f.h.request('POST', '/events', {
      teamId: f.teamA,
      title: 'Demo meetup',
      startAt: '2032-03-01T00:15Z',
      idempotencyKey: 'event-details-fixture',
      ...extra
    })
    expect(response.status).equals(201)
    return (await response.json()).id as string
  }
  const read = async (id: string): Promise<ReturnType<typeof asEventInfo>> =>
    asEventInfo(await (await f.h.request('GET', `/events/${id}/info`)).json())
  it('leaves old/default events blank, persists Practice/Other and preserves omitted metadata while moving start', async () => {
    const id = await create()
    expect(await read(id)).includes({
      eventType: 'other',
      notes: null,
      arrivalTimeDelta: null
    })
    let response = await f.h.request('PUT', `/events/${id}/info`, {
      venue: 'Demo Field',
      address: '1 Demo Way',
      notes: 'Field 2\nMeet at gate',
      arrivalTimeDelta: 45,
      eventType: 'practice'
    })
    expect(response.status).equals(200)
    expect(await read(id)).includes({
      venue: 'Demo Field',
      address: '1 Demo Way',
      notes: 'Field 2\nMeet at gate',
      arrivalTimeDelta: 45,
      eventType: 'practice'
    })
    response = await f.h.request('PUT', `/events/${id}/info`, {
      startAt: '2032-03-02T00:15Z',
      eventType: 'other'
    })
    expect(response.status).equals(200)
    expect(await read(id)).includes({
      notes: 'Field 2\nMeet at gate',
      arrivalTimeDelta: 45,
      eventType: 'other',
      startAt: '2032-03-02T00:15:00.000Z'
    })
    const list = await (
      await f.h.request('GET', `/teams/${f.teamA}/games?when=all`)
    ).json()
    expect(list.find((row: { id: string }) => row.id === id)).includes({
      notes: 'Field 2\nMeet at gate',
      arrivalTimeDelta: 45,
      eventType: 'other'
    })
    expect(
      (
        await f.h.request('PUT', `/events/${id}/info`, {
          notes: '',
          arrivalTimeDelta: 0
        })
      ).status
    ).equals(200)
    expect(await read(id)).includes({ notes: null, arrivalTimeDelta: 0 })
    expect(
      (
        await f.h.request('PUT', `/events/${id}/info`, {
          arrivalTimeDelta: null
        })
      ).status
    ).equals(200)
    expect((await read(id)).arrivalTimeDelta).equals(null)
    expect(
      (
        await f.h.request(
          'PUT',
          `/events/${id}/info`,
          { notes: 'No access' },
          102
        )
      ).status
    ).oneOf([403, 404])
  })
  it('validates creation/update fields and retries exact new metadata', async () => {
    const fields = {
      notes: 'Meet at gate',
      arrivalTimeDelta: 0,
      eventType: 'practice'
    }
    const id = await create(fields)
    expect(await create(fields)).equals(id)
    for (const extra of [
      { arrivalTimeDelta: -1 },
      { arrivalTimeDelta: 0.5 },
      { arrivalTimeDelta: '45' },
      { arrivalTimeDelta: 10081 },
      { notes: 'x'.repeat(2001) },
      { notes: {} },
      { eventType: 'game' },
      { eventType: 'bad' }
    ]) {
      expect(
        (await f.h.request('PUT', `/events/${id}/info`, extra)).status
      ).equals(400)
      expect(
        (
          await f.h.request('POST', '/events', {
            teamId: f.teamA,
            title: 'Demo meetup',
            startAt: '2032-03-01T00:15Z',
            idempotencyKey: 'event-invalid-fixture',
            ...extra
          })
        ).status
      ).equals(400)
    }
    expect((await read(id)).eventType).equals('practice')
  })
  it('migrates old game/event rows without arrival backfill and reverses the new columns', async () => {
    await sql.raw(migration058EventDetails.down).execute(f.h.db)
    await sql`insert into team_events(id, team_id, title, start_at) values ('tev_old_details', ${f.teamA}, 'Demo old event', '2032-03-01T00:15Z')`.execute(
      f.h.db
    )
    await sql`insert into games(id, home_team_id, away_team_id, start_at) values ('gam_old_details', ${f.teamA}, ${f.teamB}, '2032-03-01T00:15Z')`.execute(
      f.h.db
    )
    await sql.raw(migration058EventDetails.up).execute(f.h.db)
    expect(await read('tev_old_details')).includes({
      eventType: 'other',
      notes: null,
      arrivalTimeDelta: null
    })
    expect(await read('gam_old_details')).includes({
      eventType: 'game',
      notes: null,
      arrivalTimeDelta: null
    })
    for (const statement of [
      'update games set arrival_time_delta=-1',
      'update team_events set arrival_time_delta=10081',
      "update team_events set event_type='game'",
      "update games set notes=repeat('x',2001)"
    ]) {
      let refused = false
      try {
        await sql.raw(statement).execute(f.h.db)
      } catch (e) {
        refused = true
        expect(String(e)).includes('constraint')
      }
      expect(refused).equals(true)
    }
    await sql.raw(migration058EventDetails.down).execute(f.h.db)
    const columns = await sql<{
      column_name: string
    }>`select column_name from information_schema.columns where table_name in ('games','team_events') and column_name in ('arrival_time_delta','notes','event_type')`.execute(
      f.h.db
    )
    expect(columns.rows).length(0)
    await sql.raw(migration058EventDetails.up).execute(f.h.db)
  })
})
