import assert from 'node:assert/strict'
import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { field, input, season } from '../../common/autoScheduler/fixtures.test'
import type { PlannedGame } from '../../common/autoScheduler/types'
import { HttpError } from '../../common/errors'
import { withQueryReplies } from '../../test/queryReplies'
import * as rights from '../groups/rights'
import * as setup from '../scheduler/setup'
import * as staff from '../teams/teamStaff'
import * as facts from '../venues/fieldWarnings'
import * as calendar from '../venues/occupancy'
import * as notices from './cancel'
import { editPreview, preparePreview } from './previews'
import * as proposals from './propose'
import { publishPreview } from './publish'
import * as rescheduling from './reschedule'
import { type Snapshot, snapshot } from './snapshot'
import * as snapshotModule from './snapshot'

const clock = { now: () => new Date('2027-01-01') }
const venue = field()
const division = season()
const [home, away] = division.participants
const game: PlannedGame = {
  key: 'planned',
  seasonId: division.id,
  homeTeamId: home,
  awayTeamId: away,
  exhibition: false,
  size: '50/70',
  fieldId: venue.id,
  startAt: '2027-03-06T16:00:00Z',
  endAt: '2027-03-06T17:30:00Z'
}
const managers = { [home]: 'coach', external: 'coach' }
const outside = {
  key: 'external-game',
  pending: false,
  managerOnly: true,
  fieldId: null,
  size: null,
  homeTeamId: 'external',
  awayTeamId: 'visitor',
  seasonId: 'elsewhere',
  start: Date.parse(game.startAt),
  end: Date.parse(game.endAt)
}
const actor = { userId: 'admin', scopes: [], isAdmin: true }
const snap: Snapshot = {
  engine: input(),
  avoidHeadCoachConflicts: true,
  existing: 'workAround',
  teamIds: null,
  knownGameIds: [],
  replaceGameIds: [],
  reschedules: [],
  teams: [],
  seasons: [{ id: division.id, name: division.name, timezone: 'UTC' }],
  fields: [venue]
}
const row = {
  id: 'preview',
  league_id: 'league',
  status: 'open',
  input: snap,
  options: [{ games: [game] }],
  edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
  created_at: clock.now()
}
describe('manager-aware preview decisions without a database', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  it('discovers the required replacement manager and checks a kept game against all live intervals', async () => {
    mock.method(setup, 'scheduleSetup', async () => ({
      seasonIds: [division.id],
      fieldIds: [venue.id],
      seasons: [
        {
          ...division,
          teams: division.participants.map(id => ({
            id,
            name: id,
            exhibition: false
          }))
        }
      ]
    }))
    mock.method(
      facts,
      'fieldFacts',
      async () => new Map([[venue.id, { ...venue, switchMs: 0 }]])
    )
    mock.method(staff, 'survivors', async () => new Map([['coach', 'coach']]))
    mock.method(staff, 'rowsOfPeople', async () => ['coach'])
    mock.method(calendar, 'occupancy', async () => [outside])
    const teamRows = Object.keys(managers).map(id => ({
      scope_id: id,
      user_id: 'coach'
    }))
    const scheduled = {
      id: 'old',
      season_id: division.id,
      home_team_id: home,
      away_team_id: away,
      status: 'scheduled',
      start_at: new Date(game.startAt),
      end_at: new Date(game.endAt)
    }
    for (const overlap of [false, true]) {
      const keep = overlap
        ? game
        : {
            ...game,
            startAt: '2027-03-13T16:00:00Z',
            endAt: '2027-03-13T17:30:00Z'
          }
      await withQueryReplies(
        [
          ['from "teams"', [{ id: home }, { id: away }]],
          ['from "season_team_parents"', []],
          ['from "games"', [scheduled]],
          ['from "group_requests"', []],
          ['from "scope_roles"', teamRows.slice(0, 1)],
          ['from "users"', [{ id: 'coach' }]],
          ['from "scope_roles"', teamRows],
          ...(!overlap ? [['from "teams"', []] as [string, unknown[]]] : [])
        ],
        async db => {
          const build = snapshot(
            db,
            {
              leagueId: 'league',
              existing: 'replace',
              teamIds: [home, away],
              required: [],
              requireReplaced: true,
              keep: [keep],
              reschedules: []
            },
            clock
          )
          if (overlap) {
            await assert.rejects(build, /Manager\/Head Coach/)
          } else {
            const result = await build
            expect(result.engine.required?.[0].key).equals('replaced:old')
            expect(result.engine.headCoaches).deep.equals(managers)
            expect(result.engine.bookings[0]).includes({
              key: outside.key,
              managerOnly: true
            })
          }
        }
      )
    }
  })
  it('refuses publication before writing when another league newly books the manager', async () => {
    mock.method(rights, 'requireGroupAdmin', async () => undefined)
    mock.method(snapshotModule, 'headCoachesOf', async () => managers)
    mock.method(calendar, 'occupancy', async () => [outside])
    await withQueryReplies(
      [
        ['pg_advisory_xact_lock', []],
        ['from "schedule_previews"', [row]],
        ['pg_advisory_xact_lock', []],
        ['from "games"', []],
        ['from "group_requests"', []],
        ['from "teams"', []],
        ['from "season_schedule_settings"', []]
      ],
      async db => {
        await assert.rejects(
          publishPreview(db, actor, row.id, 0, clock),
          (err: unknown) => {
            assert(err instanceof HttpError)
            expect(err.status).equals(409)
            expect(JSON.stringify(err.details)).includes('Manager/Head Coach')
            return true
          }
        )
      }
    )
  })
  it('rejects or accepts a manual addition according to the manager’s current calendar', async () => {
    mock.method(rights, 'requireGroupAdmin', async () => undefined)
    mock.method(snapshotModule, 'headCoachesOf', async () => managers)
    let overlap = true
    mock.method(calendar, 'occupancy', async () => (overlap ? [outside] : []))
    for (const enabled of [true, false]) {
      overlap = enabled
      const preview = { ...row, options: [{ games: [] }] }
      await withQueryReplies(
        [
          ['from "schedule_previews"', [preview]],
          ['from "season_schedule_settings"', []],
          ...(!overlap
            ? ([
                ['update "schedule_previews"', []],
                ['from "schedule_previews"', [preview]]
              ] as Array<[string, unknown[]]>)
            : [])
        ],
        async db => {
          const edit = editPreview(
            db,
            actor,
            row.id,
            { option: 0, rejectedGameKeys: [], addedGames: [game] },
            clock
          )
          if (overlap) {
            await assert.rejects(edit, /Manager\/Head Coach/)
          } else {
            const edited = await edit
            expect(edited.id).equals(preview.id)
          }
        }
      )
    }
  })
  it('a recalculation retains its saved manager setting and kept matchups', async () => {
    const old = { ...row, input: { ...snap, avoidHeadCoachConflicts: false } }
    mock.method(rights, 'requireGroupAdmin', async () => undefined)
    mock.method(rescheduling, 'gamesToReschedule', async () => [])
    const capture = mock.method(
      snapshotModule,
      'snapshot',
      async () => old.input
    )
    await withQueryReplies(
      [
        ['from "schedule_previews"', [old]],
        ['insert into "schedule_previews"', []]
      ],
      async db => {
        await preparePreview(
          db,
          actor,
          row.league_id,
          { mode: 'partial', fromPreviewId: row.id },
          clock
        )
        const request = capture.mock.calls[0].arguments[1]
        assert(request != null)
        expect(request.avoidHeadCoachConflicts).equals(false)
        expect(request.keep).deep.equals([game])
      }
    )
  })

  it('checks the live manager only when adding to a published option', async () => {
    const published = { ...row, status: 'published', published_option: 0 }
    mock.method(rights, 'requireGroupAdmin', async () => undefined)
    mock.method(rescheduling, 'rejectPublished', async () => undefined)
    mock.method(rescheduling, 'publishedStates', async () => [])
    mock.method(proposals, 'proposePlanned', async () => undefined)
    mock.method(notices, 'noticeTeams', async () => undefined)
    mock.method(snapshotModule, 'headCoachesOf', async () => managers)
    const lookup = mock.method(calendar, 'occupancy', async () => [outside])
    await withQueryReplies(
      [
        ['from "schedule_previews"', [published]],
        ['pg_advisory_xact_lock', []],
        ['from "schedule_previews"', [published]]
      ],
      async db => {
        const result = await editPreview(
          db,
          actor,
          row.id,
          { option: 0, rejectedGameKeys: [game.key], addedGames: [] },
          clock
        )
        expect(result.status).equals('published')
        expect(lookup.mock.callCount()).equals(0)
      }
    )
    await withQueryReplies(
      [
        ['from "schedule_previews"', [published]],
        ['pg_advisory_xact_lock', []],
        ['from "season_schedule_settings"', []]
      ],
      async db => {
        await assert.rejects(
          editPreview(
            db,
            actor,
            row.id,
            { option: 0, rejectedGameKeys: [], addedGames: [game] },
            clock
          ),
          /Manager\/Head Coach/
        )
        expect(lookup.mock.callCount()).equals(1)
      }
    )
  })
})
