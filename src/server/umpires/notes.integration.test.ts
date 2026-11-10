import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import type { GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'

describe('custom umpire game notes', function () {
  this.timeout(60000)
  let f: GroupFixture, client: TeamStationClient, clock: string | undefined
  beforeEach(async () => {
    clock = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    client = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
  })
  afterEach(async () => {
    await f?.h.close()
    if (clock == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = clock
  })
  it('stores independent cells, returns them on authorized schedules, and clears only the selected cell', async () => {
    const jersey = await client.addUmpireNoteType(f.leagueA, ' Jersey Color ')
    const venue = await client.addUmpireNoteType(f.leagueA, 'Venue Contact')
    expect(jersey.name).equals('Jersey Color')
    expect(jersey.inUse).equals(false)
    await f.h.db
      .updateTable('games')
      .set({ notes: 'Event notes' })
      .where('id', '=', 'gam_umpire')
      .execute()
    await client.saveUmpireNote('gam_umpire', jersey.id, '', 'Blue')
    await client.saveUmpireNote('gam_umpire', venue.id, '', 'Demo contact')
    const schedule = await client.umpireSchedule(f.leagueA)
    expect(schedule.noteTypes.map(t => t.name)).deep.equals([
      'Jersey Color',
      'Venue Contact'
    ])
    expect(schedule.games[0].umpireNotes).deep.equals({
      [jersey.id]: 'Blue',
      [venue.id]: 'Demo contact'
    })
    expect(schedule.games[0].notes).equals('Event notes')
    expect((await client.umpireNoteTypes(f.leagueA))[0].inUse).equals(true)
    expect(
      await client.saveUmpireNote('gam_umpire', jersey.id, '', 'Blue')
    ).deep.equals({ value: 'Blue' })
    await client.saveUmpireNote('gam_umpire', jersey.id, 'Blue', '  ')
    expect(
      (await client.umpireSchedule(f.leagueA)).games[0].umpireNotes
    ).deep.equals({ [venue.id]: 'Demo contact' })
    await client.removeUmpireNoteType(f.leagueA, venue.id)
    expect(
      await f.h.db.selectFrom('game_umpire_notes').selectAll().execute()
    ).length(0)
    await client.saveUmpireNote('gam_umpire', jersey.id, '', 'Gold')
    await f.h.db.deleteFrom('games').where('id', '=', 'gam_umpire').execute()
    expect(
      await f.h.db.selectFrom('game_umpire_notes').selectAll().execute()
    ).length(0)
  })
  it('validates names, bodies, ownership, enabled management and administrator access', async () => {
    const t = await client.addUmpireNoteType(f.leagueA, 'Color')
    for (const name of ['', null, 'COLOR', 'x'.repeat(101)])
      expect(
        (
          await f.h.request(
            'POST',
            `/leagues/${f.leagueA}/umpire-note-types`,
            { name },
            101
          )
        ).status
      ).equals(400)
    const path = `/games/gam_umpire/umpire-notes/${t.id}`
    for (const body of [
      null,
      {},
      { before: '', value: 1 },
      { before: '', value: 'x'.repeat(2001) }
    ])
      expect((await f.h.request('PUT', path, body, 101)).status).equals(400)
    expect(
      (await f.h.request('PUT', path, { before: '', value: 'Blue' }, 103))
        .status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'GET',
          `/leagues/${f.leagueA}/umpire-note-types`,
          undefined,
          103
        )
      ).status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'GET',
          `/leagues/${f.leagueA}/umpire-schedule`,
          undefined,
          102
        )
      ).status
    ).equals(403)
    const other = await f.h.request(
      'POST',
      `/leagues/${f.leagueB}/umpire-note-types`,
      { name: 'Other' },
      102
    )
    const foreign = (await other.json()).id
    expect(
      (
        await f.h.request(
          'PUT',
          `/games/gam_umpire/umpire-notes/${foreign}`,
          { before: '', value: 'Blue' },
          101
        )
      ).status
    ).equals(404)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/leagues/${f.leagueB}/umpire-note-types/${t.id}`,
          undefined,
          102
        )
      ).status
    ).equals(404)
    expect(
      (
        await f.h.request(
          'PUT',
          `/games/missing/umpire-notes/${t.id}`,
          { before: '', value: '' },
          101
        )
      ).status
    ).equals(404)
    await client.setUmpireSettings(f.leagueA, { management: false })
    expect(
      (await f.h.request('PUT', path, { before: '', value: 'Blue' }, 101))
        .status
    ).equals(403)
    expect(
      await f.h.db.selectFrom('game_umpire_notes').selectAll().execute()
    ).length(0)
  })
  it('serializes concurrent edits, rejects stale writes and accepts retries', async () => {
    const t = await client.addUmpireNoteType(f.leagueA, 'Color')
    const path = `/games/gam_umpire/umpire-notes/${t.id}`
    const results = await Promise.all(
      ['Blue', 'Gold'].map(
        async value =>
          await f.h.request('PUT', path, { before: '', value }, 101)
      )
    )
    expect(results.map(r => r.status).sort((a, b) => a - b)).deep.equals([
      200, 409
    ])
    const value = (await results.find(r => r.status === 200)!.json()).value
    expect(
      (await f.h.request('PUT', path, { before: '', value }, 101)).status
    ).equals(200)
    expect(
      (await f.h.request('PUT', path, { before: '', value: 'Red' }, 101)).status
    ).equals(409)
    await client.saveUmpireNote('gam_umpire', t.id, value, 'Red')
    expect(
      (await client.umpireSchedule(f.leagueA)).games[0].umpireNotes[t.id]
    ).equals('Red')
  })
})
