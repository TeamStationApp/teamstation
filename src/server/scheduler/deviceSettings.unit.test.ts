import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { season } from '../../common/autoScheduler/fixtures.test'
import type { FieldChanges, VenueChanges } from '../../common/venues'
import { weeklyWindow } from '../../common/windowPeriods'
import { migrations } from '../../migrate/migrations'
import { withQueryReplies } from '../../test/queryReplies'
import { fieldFacts } from '../venues/fieldWarnings'
import * as ownership from '../venues/ownership'
import { updateField, updateVenue, type VenueServices } from '../venues/venues'
import { saveSeasonScheduleSettings, scheduleSetup } from './setup'

const hours = [{ weekday: 6, start: '08:00', end: '18:00' }]
const windows = weeklyWindow(hours)
const venue = {
  id: 'ven_demo',
  google_place_id: 'demo',
  name: 'Demo Park',
  address: '1 Example Way',
  timezone: 'UTC',
  latitude: 40,
  longitude: -75,
  size_switch_minutes: 0,
  default_hours: hours,
  default_windows: windows,
  default_blackouts: [],
  photo_path: null
}
const field = {
  id: 'fld_one',
  venue_id: venue.id,
  name: 'Field 1',
  sizes: ['50/70'],
  starts_on: null,
  ends_on: null,
  hours,
  windows,
  blackouts: [],
  pin_latitude: null,
  pin_longitude: null,
  photo_path: null,
  deleted_at: null
}
const actor = { userId: 'admin', scopes: [], isAdmin: true }
const services: VenueServices = {
  media: {
    mediaRoot: '',
    ffmpegPath: '',
    mediaSecret: '',
    publicUrl: '',
    space: {
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: ''
    }
  },
  map: { tileUrl: '' }
}

describe('device scheduling persistence boundaries', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  it('registers distinct migration steps in dependency order', () => {
    expect(new Set(migrations.map(item => item.name)).size).equals(
      migrations.length
    )
    expect(migrations.slice(-2).map(item => item.name)).deep.equals([
      '117deviceScheduling',
      '118devicePreviews'
    ])
  })
  it('retains dated windows in field facts and distinguishes inheritance from closure', async () => {
    for (const own of [null, [], windows]) {
      await withQueryReplies(
        [
          [
            'from "venue_fields"',
            [
              {
                ...venue,
                field_id: field.id,
                field_name: field.name,
                sizes: field.sizes,
                starts_on: null,
                ends_on: null,
                hours,
                windows: own,
                blackouts: [],
                deleted_at: null
              }
            ]
          ]
        ],
        async db => {
          const facts = (await fieldFacts(db, [field.id])).get(field.id)!
          expect(facts.availability.windows).deep.equals(own ?? windows)
        }
      )
    }
  })
  it('writes selected fields, preserves omitted choices, drops stale stored fields and refuses unavailable added ones', async () => {
    const settings = season().settings
    const row = {
      season_id: 'sea_demo',
      field_ids: ['fld_one'],
      field_size: '50/70',
      game_minutes: 90,
      buffer_minutes: 10,
      regular_games: 4,
      exhibition_games: 1,
      doubleheaders: 'ifNecessary',
      starts_on: settings.startsOn,
      ends_on: settings.endsOn,
      blackouts: [],
      windows: settings.windows,
      max_games_on_weekdays: 2,
      max_games_on_weekend: 2,
      prefer_game_on: 'weekend'
    }
    for (const mode of [
      'chosen',
      'omitted',
      'empty',
      'size',
      'missing',
      'deleted',
      'incompatible',
      'addedMissing',
      'addedDeleted',
      'addedIncompatible'
    ]) {
      let wrote = false
      const added = mode.startsWith('added')
      const stored = { ...row, field_ids: added ? [] : row.field_ids }
      const wanted = {
        ...settings,
        fieldIds:
          mode === 'omitted' ? undefined : mode === 'empty' ? [] : ['fld_one'],
        fieldSize: mode === 'size' ? ('60/90' as const) : ('50/70' as const)
      }
      await withQueryReplies(
        query => {
          if (query.sql.startsWith('insert into "season_schedule_settings"')) {
            wrote = true
            expect(query.parameters).deep.includes(
              mode === 'chosen' || mode === 'omitted' ? ['fld_one'] : []
            )
            return []
          }
          if (query.sql.includes('from "season_schedule_settings"'))
            return [stored]
          if (query.sql.includes('from "seasons"'))
            return [
              {
                id: 'sea_demo',
                league_id: 'lea_demo',
                year: 2027,
                starts_on: settings.startsOn,
                ends_on: settings.endsOn
              }
            ]
          if (query.sql.includes('from "venue_fields"'))
            return /missing/i.test(mode)
              ? []
              : [
                  {
                    id: field.id,
                    sizes: /incompatible/i.test(mode) ? ['60/90'] : ['50/70'],
                    deleted_at: /deleted/i.test(mode) ? new Date() : null
                  }
                ]
          throw new Error(query.sql)
        },
        async db => {
          if (added) {
            const error = await saveSeasonScheduleSettings(
              db,
              'sea_demo',
              wanted
            ).catch((error: unknown) => error)
            expect(error).instanceOf(Error)
            expect(wrote).equals(false)
          } else {
            await saveSeasonScheduleSettings(db, 'sea_demo', wanted)
            expect(wrote).equals(true)
          }
        }
      )
    }
  })
  it('lists the union of season selections and legacy run selections', async () => {
    await withQueryReplies(
      query => {
        if (query.sql.includes('from "league_schedule_setups"'))
          return [
            {
              season_ids: ['sea_demo'],
              field_ids: ['legacy'],
              added_field_ids: []
            }
          ]
        if (query.sql.includes('from "seasons"'))
          return [
            {
              id: 'sea_demo',
              name: 'Demo',
              year: 2027,
              timezone: 'UTC',
              league_id: 'league',
              starts_on: '2027-03-01',
              ends_on: '2027-06-30'
            }
          ]
        if (query.sql.includes('from "season_schedule_settings"'))
          return [
            {
              season_id: 'sea_demo',
              field_ids: ['fld_one'],
              field_size: '50/70',
              windows,
              blackouts: [],
              starts_on: '2027-03-01',
              ends_on: '2027-06-30'
            }
          ]
        if (query.sql.includes('from "venue_fields"')) {
          expect(query.parameters).includes.members(['legacy', 'fld_one'])
          return [
            { ...field, venue_name: venue.name },
            { ...field, id: 'legacy', venue_name: venue.name }
          ]
        }
        return []
      },
      async db => {
        const setup = await scheduleSetup(db, 'league')
        expect(setup.fields.map(item => item.id)).deep.equals([
          'fld_one',
          'legacy'
        ])
        expect(setup.seasons[0].settings.fieldIds).deep.equals(['fld_one'])
      }
    )
  })
  it('stores dated and legacy venue/field updates and notifies dependent games, including inheritance and closure', async () => {
    mock.method(ownership, 'requireVenueEditor', async () => undefined)
    mock.method(ownership, 'settleClaims', async () => [])
    mock.method(ownership, 'liveClaims', async () => [])
    mock.method(ownership, 'describeClaims', async () => ({
      owners: [],
      claims: []
    }))
    mock.method(ownership, 'venueRights', async () => ({ canEdit: true }))
    for (const [kind, changes] of [
      ['venue', { defaultWindows: windows }],
      ['venue', { defaultHours: hours }],
      ['venue', { defaultWindows: [] }],
      ['field', { windows }],
      ['field', { windows: null }],
      ['field', { windows: [] }],
      ['field', { hours }],
      ['field', { hours: null }]
    ] as const) {
      let notified = false
      let wrote = false
      await withQueryReplies(
        query => {
          if (query.sql.startsWith('update ')) {
            wrote = true
            expect(query.sql).includes(
              kind === 'venue' ? '"default_windows"' : '"windows"'
            )
            // Legacy readers of the hours columns see the hours in use.
            expect(query.sql).includes(
              kind === 'venue' ? '"default_hours"' : '"hours"'
            )
            return []
          }
          if (query.sql.includes('from "venue_fields"')) return [field]
          if (query.sql.includes('from "venues"')) return [venue]
          if (query.sql.includes('pg_advisory_xact_lock')) return []
          throw new Error(query.sql)
        },
        async db => {
          const notify = async (): Promise<void> => {
            notified = true
          }
          if (kind === 'venue')
            await updateVenue(
              db,
              actor,
              venue.id,
              changes as VenueChanges,
              services,
              notify
            )
          else
            await updateField(
              db,
              actor,
              venue.id,
              field.id,
              changes as FieldChanges,
              services,
              notify
            )
        }
      )
      expect(wrote).equals(true)
      expect(notified).equals(true)
    }
  })
})
