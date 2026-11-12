import { expect } from 'chai'
import { sql } from 'kysely'
import { describe, it } from 'mocha'

import { fieldWindows } from '../../common/fieldAvailability'
import { migration117DeviceScheduling } from '../../migrate/migrations/117deviceScheduling'
import {
  api,
  autoSchedulerFixture,
  seedThrough
} from '../../test/autoSchedulerFixture'
import { googlePlacesStub } from '../../test/googlePlacesStub'
import { googlePlaces } from '../location/googlePlaces'
import { seasonScheduleSettings } from '../scheduler/setup'
import { fieldFacts } from '../venues/fieldWarnings'

// Uses isolated fixture databases; no production data.
describe('device scheduler constraints persistence', function () {
  this.timeout(60000)
  it('round-trips field choices and dated inheritance, rejecting incompatible choices', async () => {
    const places = await googlePlacesStub()
    const fx = await autoSchedulerFixture(undefined, {
      cityLookup: googlePlaces({ apiKey: 'test', baseUrl: places.baseUrl })
    })
    try {
      const { venueId, fieldId } = await seedThrough(fx, 'E7')
      const settings = await seasonScheduleSettings(fx.f.h.db, fx.f.seasonA)
      expect(settings.settings.fieldIds).deep.equals([fieldId])
      await api(fx, 101, 'PUT', `/venues/${venueId}`, {
        defaultWindows: [
          {
            from: '2027-03-01',
            until: '2027-03-06',
            hours: [{ weekday: 6, start: '08:00', end: '12:00' }]
          },
          {
            from: '2027-03-20',
            hours: [{ weekday: 6, start: '18:00', end: '22:00' }]
          }
        ]
      })
      await api(fx, 101, 'PUT', `/venues/${venueId}/fields/${fieldId}`, {
        windows: null
      })
      let availability = (await fieldFacts(fx.f.h.db, [fieldId!])).get(
        fieldId!
      )!.availability
      expect(fieldWindows(availability, '2027-03-06')).length(1)
      expect(fieldWindows(availability, '2027-03-13')).length(0)
      expect(fieldWindows(availability, '2027-03-20')).length(1)
      await api(fx, 101, 'PUT', `/venues/${venueId}/fields/${fieldId}`, {
        windows: []
      })
      availability = (await fieldFacts(fx.f.h.db, [fieldId!])).get(
        fieldId!
      )!.availability
      expect(fieldWindows(availability, '2027-03-20')).length(0)
      await api(fx, 101, 'PUT', `/seasons/${fx.f.seasonA}/schedule-settings`, {
        ...settings.settings,
        fieldSize: '60/90'
      })
      const changed = await seasonScheduleSettings(fx.f.h.db, fx.f.seasonA)
      expect(changed.settings.fieldIds).deep.equals([])
      const response = await fx.f.h.request(
        'PUT',
        `/seasons/${fx.f.seasonA}/schedule-settings`,
        { ...changed.settings, fieldIds: [fieldId] },
        101
      )
      expect(response.status).equals(400)
    } finally {
      await fx.f.h.close()
      await places.close()
    }
  })

  it('backfills weekly hours and historical preview JSON without changing options', async () => {
    const places = await googlePlacesStub()
    const fx = await autoSchedulerFixture(undefined, {
      cityLookup: googlePlaces({ apiKey: 'test', baseUrl: places.baseUrl })
    })
    try {
      const { fieldId } = await seedThrough(fx, 'E7')
      const db = fx.f.h.db
      await sql.raw(migration117DeviceScheduling.down).execute(db)
      const oldInput = {
        engine: {
          seasons: [{ id: fx.f.seasonA, settings: { fieldSize: '50/70' } }],
          fields: [
            {
              id: fieldId,
              sizes: ['50/70'],
              availability: {
                hours: [{ weekday: 6, start: '08:00', end: '12:00' }]
              }
            }
          ]
        }
      }
      await db
        .insertInto('schedule_previews')
        .values({
          id: 'spv_legacy',
          league_id: fx.f.leagueA,
          created_by: (
            await db.selectFrom('users').select('id').executeTakeFirstOrThrow()
          ).id,
          mode: 'full',
          input: JSON.stringify(oldInput),
          options: '[]',
          blocking: null,
          status: 'published',
          published_at: new Date(),
          published_option: 0,
          removed_games: 0
        })
        .execute()
      await sql.raw(migration117DeviceScheduling.up).execute(db)
      const row = await db
        .selectFrom('schedule_previews')
        .selectAll()
        .where('id', '=', 'spv_legacy')
        .executeTakeFirstOrThrow()
      const snap = row.input as typeof oldInput & {
        engine: {
          seasons: Array<{ settings: { fieldIds: string[] } }>
          fields: Array<{ availability: { windows: unknown[] } }>
        }
      }
      expect(snap.engine.seasons[0].settings.fieldIds).deep.equals([fieldId])
      expect(snap.engine.fields[0].availability.windows).deep.equals([
        {
          from: '0001-01-01',
          hours: oldInput.engine.fields[0].availability.hours
        }
      ])
      expect(row.status).equals('published')
      expect(row.options).deep.equals([])
      expect(
        (await seasonScheduleSettings(db, fx.f.seasonA)).settings.fieldIds
      ).deep.equals([fieldId])
    } finally {
      await fx.f.h.close()
      await places.close()
    }
  })
})
