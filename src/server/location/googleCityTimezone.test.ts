import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asLocality } from '../../common/locality'
import { googlePlacesStub } from '../../test/googlePlacesStub'
import { groupFixture } from '../../test/groupFixtures'
import { googlePlaces } from './googlePlaces'

describe('selected city time-zone storage', () => {
  it('keeps the border-town zone through lookup, league storage and season creation', async () => {
    const stub = await googlePlacesStub()
    stub.controls.timeZoneFail = true
    const f = await groupFixture(
      undefined,
      undefined,
      undefined,
      googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
    )
    try {
      const response = await f.h.request(
        'GET',
        '/locations/google:bemposta?session=border-session',
        undefined,
        101
      )
      expect(response.status).equals(200)
      const locality = asLocality((await response.json()).place)
      expect(locality.timezone).equals('Europe/Lisbon')
      expect(locality).not.has.property('latitude')
      expect(locality).not.has.property('longitude')
      const created = await f.h.request(
        'POST',
        '/leagues',
        {
          name: 'Border League',
          locality,
          idempotencyKey: 'border-zone-league'
        },
        101
      )
      expect(created.status).equals(201)
      const league = await created.json()
      const stored = await f.h.db
        .selectFrom('leagues')
        .select('locality')
        .where('id', '=', league.id)
        .executeTakeFirstOrThrow()
      expect(stored.locality).deep.equals(locality)
      const season = await f.h.request(
        'POST',
        '/seasons',
        {
          name: 'Spring 2027',
          parent: { kind: 'league', id: league.id },
          startsOn: '2027-03-01',
          endsOn: '2027-05-31',
          timezone: asLocality(stored.locality).timezone,
          idempotencyKey: 'border-zone-season'
        },
        101
      )
      expect(season.status).equals(201)
      expect(
        (
          await f.h.db
            .selectFrom('seasons')
            .select('timezone')
            .where('id', '=', (await season.json()).id)
            .executeTakeFirstOrThrow()
        ).timezone
      ).equals('Europe/Lisbon')
    } finally {
      await f.h.close()
      await stub.close()
    }
  }).timeout(60000)
})
