import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { input } from '../../common/autoScheduler/fixtures.test'
import type {
  EngineResult,
  PlannedGame
} from '../../common/autoScheduler/types'
import { withQueryReplies } from '../../test/queryReplies'
import * as rights from '../groups/rights'
import {
  completePreview,
  editPreview,
  preparePreview,
  type PreviewRow
} from './previews'
import * as reschedules from './reschedule'
import type { Snapshot } from './snapshot'
import * as snapshotModule from './snapshot'

const actor = { userId: 'admin', scopes: [], isAdmin: true }
const clock = { now: () => new Date('2027-01-01') }
const game: PlannedGame = {
  key: 'one',
  seasonId: 'sea_demo',
  homeTeamId: 'tem_hawks',
  awayTeamId: 'tem_owls',
  exhibition: false,
  size: '50/70',
  fieldId: 'fld_one',
  startAt: '2027-03-06T16:00:00Z',
  endAt: '2027-03-06T17:30:00Z'
}
const result: EngineResult = {
  options: [{ games: [game], fairness: [], reasons: [], unmet: [], score: [] }],
  blocking: null
}
const snapshot = (): Snapshot => ({
  engine: input(),
  existing: 'workAround',
  teamIds: null,
  knownGameIds: [],
  replaceGameIds: [],
  reschedules: [],
  teams: [],
  seasons: [],
  fields: []
})
const pending = (id: string): PreviewRow => ({
  id,
  league_id: 'league',
  mode: 'full',
  created_by: actor.userId,
  created_at: clock.now(),
  input: { ...snapshot(), preparation: {} },
  options: [],
  blocking: null,
  edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
  status: 'building',
  published_option: null,
  published_at: null,
  removed_games: null,
  result_hash: null
})

/** A storage-boundary stub; transactions and query generation still run through Kysely. */
async function stored(
  rows: Map<string, PreviewRow>,
  work: Parameters<typeof withQueryReplies>[1],
  seen: string[] = []
): Promise<void> {
  await withQueryReplies(query => {
    seen.push(query.sql)
    if (query.sql.startsWith('select'))
      return [rows.get(String(query.parameters[0]))].filter(row => row != null)
    if (query.sql.startsWith('insert')) {
      const names = [
        ...query.sql
          .slice(0, query.sql.indexOf(' values'))
          .matchAll(/"([a-z_]+)"/g)
      ]
        .map(match => match[1])
        .slice(1)
      const values = Object.fromEntries(
        names.map((name, index) => [
          name,
          ['input', 'options', 'edits'].includes(name)
            ? JSON.parse(String(query.parameters[index]))
            : query.parameters[index]
        ])
      )
      const row = { ...pending(String(values.id)), ...values }
      rows.set(row.id, row)
      return []
    }
    if (query.sql.startsWith('update')) {
      const row = rows.get(String(query.parameters.at(-1)))!
      for (const [, name, index] of query.sql.matchAll(/"(\w+)" = \$(\d+)/g)) {
        if (name === 'id') continue
        const value = query.parameters[Number(index) - 1]
        Object.assign(row, {
          [name]: ['input', 'options', 'edits'].includes(name)
            ? JSON.parse(String(value))
            : value
        })
      }
      return []
    }
    if (query.sql.startsWith('delete from "schedule_previews"')) {
      const [status, before] = query.parameters
      for (const [id, row] of rows)
        if (row.status === status && row.created_at < (before as Date))
          rows.delete(id)
      return []
    }
    throw new Error(query.sql)
  }, work)
}

describe('device preview state transitions without a database', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  const authorize = (): void => {
    mock.method(rights, 'requireGroupAdmin', async () => undefined)
  }
  it('prepares only input, completes once, and preserves the receipt on matching retries', async () => {
    authorize()
    mock.method(reschedules, 'gamesToReschedule', async () => [])
    mock.method(snapshotModule, 'snapshot', async () => snapshot())
    const rows = new Map<string, PreviewRow>([
      [
        'abandoned',
        // Another league's: one that never builds again leaves none behind.
        {
          ...pending('abandoned'),
          league_id: 'other',
          created_at: new Date('2026-12-30')
        }
      ],
      [
        'recent',
        { ...pending('recent'), created_at: new Date('2026-12-31T12:00:00Z') }
      ]
    ])
    await stored(rows, async db => {
      const prepared = await preparePreview(
        db,
        actor,
        'league',
        { mode: 'full', existing: 'workAround' },
        clock
      )
      // A build left waiting over a day is dropped; a newer one is kept.
      expect(rows.has('abandoned')).equals(false)
      expect(rows.has('recent')).equals(true)
      expect(rows.get(prepared.id)?.status).equals('building')
      expect(rows.get(prepared.id)?.options).deep.equals([])
      const complete = await completePreview(
        db,
        actor,
        prepared.id,
        result,
        clock
      )
      // Stored under a key the server made, otherwise as sent.
      const { key: _key, ...placed } = complete.options[0].games[0]
      const { key: _sent, ...sent } = game
      expect(placed).deep.equals(sent)
      expect(complete.options[0].games[0].key).matches(/^placed:/)
      expect(complete.status).equals('open')
      expect(
        await completePreview(db, actor, prepared.id, result, clock)
      ).deep.equals(complete)
      const refused = await completePreview(
        db,
        actor,
        prepared.id,
        { options: [], blocking: 'different' },
        clock
      ).catch((error: unknown) => error)
      expect(refused).instanceOf(Error)
    })
  })
  it('refuses editing a building preview, missing preparation and stale sources without changing the source', async () => {
    authorize()
    const row = pending('new')
    const old: PreviewRow = { ...pending('old'), status: 'open' }
    const rows = new Map([
      ['new', row],
      ['old', old]
    ])
    await stored(rows, async db => {
      expect(
        await editPreview(
          db,
          actor,
          'new',
          { option: 0, rejectedGameKeys: [], addedGames: [] },
          clock
        ).catch((error: unknown) => error)
      ).instanceOf(Error)
      delete (row.input as Snapshot).preparation
      expect(
        await completePreview(db, actor, 'new', result, clock).catch(
          (error: unknown) => error
        )
      ).instanceOf(Error)
      for (const status of ['discarded', 'published', 'open'] as const) {
        old.status = status
        ;(row.input as Snapshot).preparation = {
          earlier: { id: 'old', edits: {} }
        }
        expect(
          await completePreview(db, actor, 'new', result, clock).catch(
            (error: unknown) => error
          )
        ).instanceOf(Error)
        expect(row.status).equals('building')
      }
    })
  })
  it('retains kept games and discards the source on acceptance, but keeps it when nothing is placed again', async () => {
    authorize()
    for (const blocked of [false, true]) {
      const row = pending('new')
      const old: PreviewRow = { ...pending('old'), status: 'open' }
      const kept = {
        ...game,
        key: 'kept',
        startAt: '2027-03-13T16:00:00Z',
        endAt: '2027-03-13T17:30:00Z'
      }
      const snap = row.input as Snapshot
      snap.preparation = {
        keep: [kept],
        earlier: { id: 'old', edits: old.edits }
      }
      snap.engine.fixed = [
        {
          ...kept,
          start: Date.parse(kept.startAt),
          end: Date.parse(kept.endAt)
        }
      ]
      await stored(
        new Map([
          ['new', row],
          ['old', old]
        ]),
        async db => {
          if (blocked) {
            // The device says why, and the preview it recalculated stays.
            const error = await completePreview(
              db,
              actor,
              'new',
              { options: [], blocking: 'Anything a device sends' },
              clock
            ).catch((caught: unknown) => caught)
            expect(String(error)).includes(
              'None of the rejected games could be placed again'
            )
            expect(String(error)).includes('Anything a device sends')
            expect(old.status).equals('open')
            expect(row.status).equals('discarded')
            // The same result sent again, its answer lost, gets the same
            // reason, not that the preview no longer waits.
            const again = await completePreview(
              db,
              actor,
              'new',
              { options: [], blocking: 'Anything a device sends' },
              clock
            ).catch((caught: unknown) => caught)
            expect(String(again)).equals(String(error))
            return
          }
          const completed = await completePreview(
            db,
            actor,
            'new',
            result,
            clock
          )
          expect(old.status).equals('discarded')
          expect(
            completed.options[0].games.map(game =>
              game.key.startsWith('placed:') ? 'placed' : game.key
            )
          ).deep.equals(['placed', 'kept'])
        }
      )
    }
  })
  it('keys the device’s games itself, and refuses a requested game placed twice', async () => {
    authorize()
    const row = pending('new')
    await stored(new Map([['new', row]]), async db => {
      // Repeated keys and the server's own prefixes come back as its keys.
      const completed = await completePreview(
        db,
        actor,
        'new',
        {
          ...result,
          options: [
            {
              ...result.options[0],
              games: [game, { ...game, key: 'replaced:gam_one' }]
            }
          ]
        },
        clock
      )
      const keys = completed.options[0].games.map(each => each.key)
      expect(new Set(keys).size).equals(2)
      for (const key of keys) expect(key).matches(/^placed:/)
    })
    const twice = pending('twice')
    ;(twice.input as Snapshot).engine.required = [
      {
        key: 'listed:one',
        seasonId: game.seasonId,
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        exhibition: false
      }
    ]
    await stored(new Map([['twice', twice]]), async db => {
      const requested = { ...game, key: 'listed:one' }
      const error = await completePreview(
        db,
        actor,
        'twice',
        {
          ...result,
          options: [{ ...result.options[0], games: [requested, requested] }]
        },
        clock
      ).catch((caught: unknown) => caught)
      expect(String(error)).includes('Place each requested game once')
      expect(twice.status).equals('building')
    })
  })
  it('refuses to complete a build left waiting past its day', async () => {
    authorize()
    const row = { ...pending('old'), created_at: new Date('2026-12-30') }
    await stored(new Map([['old', row]]), async db => {
      const error = await completePreview(
        db,
        actor,
        'old',
        result,
        clock
      ).catch((caught: unknown) => caught)
      expect(String(error)).includes('Prepare the schedule again')
      expect(row.status).equals('building')
    })
  })
  it('stores the device’s options as sent, summaries and all, for publication to check', async () => {
    authorize()
    const row = pending('new')
    // A season with no windows: the device broke its rules, and it is its
    // league's own schedule. Publishing checks games against live bookings.
    const snap = row.input as Snapshot
    snap.engine.seasons[0].settings.windows = []
    const summarized = {
      ...result,
      options: result.options.map(option => ({
        ...option,
        reasons: ['As the device found it'],
        score: [1, 2, 3]
      }))
    }
    await stored(new Map([['new', row]]), async db => {
      const completed = await completePreview(
        db,
        actor,
        'new',
        summarized,
        clock
      )
      expect(completed.status).equals('open')
      expect(completed.options[0]).deep.includes({
        reasons: ['As the device found it'],
        score: [1, 2, 3]
      })
    })
  })
})
