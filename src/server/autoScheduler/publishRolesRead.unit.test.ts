import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { input } from '../../common/autoScheduler/fixtures.test'
import type { SchedulePreview } from '../../common/schedulePreviews'
import { withQueryReplies } from '../../test/queryReplies'
import { accountReadOnce, readOnce, withRolesRead } from '../db/readOnce'
import * as cancel from './cancel'
import type { PreviewRow } from './previews'
import * as previews from './previews'
import * as propose from './propose'
import { publishPreview } from './publish'
import * as reschedule from './reschedule'
import * as snapshot from './snapshot'

const actor = { userId: 'admin', scopes: [], isAdmin: true }
const clock = { now: () => new Date('2027-01-01') }
const row: PreviewRow = {
  id: 'preview',
  league_id: 'league',
  mode: 'full',
  created_by: actor.userId,
  created_at: clock.now(),
  input: {
    engine: input(),
    existing: 'workAround',
    teamIds: null,
    knownGameIds: [],
    replaceGameIds: [],
    reschedules: [],
    teams: [],
    seasons: [],
    fields: [],
    preparation: {}
  },
  options: [{ games: [], fairness: [], reasons: [], unmet: [], score: [] }],
  blocking: null,
  edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
  status: 'open',
  published_option: null,
  published_at: null,
  removed_games: null,
  result_hash: null,
  proven_optimal: true
}

describe('a publication’s rights', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('reads each person’s account once while it proposes the games and tells the teams', async () => {
    mock.method(previews, 'previewFor', async () => row)
    mock.method(previews, 'lockScheduleForWrite', async () => undefined)
    mock.method(previews, 'currentHoldings', async () => ({
      holdings: [],
      headCoaches: {}
    }))
    mock.method(
      previews,
      'previewView',
      async () =>
        ({
          published: []
        }) as unknown as SchedulePreview
    )
    mock.method(snapshot, 'runGames', async () => [])
    mock.method(snapshot, 'pendingSchedulerProposals', async () => [])
    mock.method(cancel, 'cancelAsRescheduled', async () => [])
    mock.method(reschedule, 'gamesToReschedule', async () => [])
    const reads: string[] = []
    const twice = async (db: unknown, step: string): Promise<void> => {
      for (let i = 0; i < 2; i++)
        await accountReadOnce(
          db as Parameters<typeof accountReadOnce>[0],
          'coach',
          async () => {
            reads.push(step)
            return step
          }
        )
    }
    const proposed = mock.method(
      propose,
      'proposePlanned',
      async (db: unknown) => {
        await twice(db, 'propose')
      }
    )
    const noticed = mock.method(cancel, 'noticeTeams', async (db: unknown) => {
      await twice(db, 'notice')
    })
    await withQueryReplies(
      query => (query.sql.includes('from "schedule_previews"') ? [row] : []),
      async db => {
        const published = await publishPreview(db, actor, row.id, 0, clock)
        expect(published).deep.equals({
          preview: { published: [] },
          scheduled: 0,
          awaiting: 0,
          removed: 0
        })
      }
    )
    expect(proposed.mock.callCount()).equals(1)
    expect(noticed.mock.callCount()).equals(1)
    // Once for the publication, not once per check: neither changes roles.
    expect(reads).deep.equals(['propose'])
  })

  it('resolves the listed games a full build placed again, one statement for each preview', async () => {
    const listed = [
      { previewId: 'p1', gameKey: 'k1' },
      { previewId: 'p1', gameKey: 'k2' },
      { previewId: 'p2', gameKey: 'k3' }
    ]
    const built: PreviewRow = {
      ...row,
      input: {
        ...(row.input as object),
        seasons: [{ id: 'season', name: 'Spring', timezone: 'UTC' }],
        reschedules: listed
      }
    }
    mock.method(previews, 'previewFor', async () => built)
    mock.method(previews, 'lockScheduleForWrite', async () => undefined)
    mock.method(previews, 'currentHoldings', async () => ({
      holdings: [],
      headCoaches: {}
    }))
    mock.method(
      previews,
      'previewView',
      async () => ({ published: [] }) as unknown as SchedulePreview
    )
    mock.method(snapshot, 'runGames', async () => [])
    mock.method(snapshot, 'pendingSchedulerProposals', async () => [])
    mock.method(cancel, 'cancelAsRescheduled', async () => [])
    mock.method(cancel, 'noticeTeams', async () => undefined)
    mock.method(propose, 'proposePlanned', async () => undefined)
    mock.method(reschedule, 'gamesToReschedule', async () => [
      ...listed.map(ref => ({ ...ref, seasonId: 'season' })),
      // Listed since the build, so it stays listed.
      { previewId: 'p2', gameKey: 'k4', seasonId: 'season' }
    ])
    const resolved: unknown[][] = []
    await withQueryReplies(
      query => {
        if (query.sql.startsWith('update "schedule_preview_games"'))
          resolved.push(query.parameters.slice(1))
        return query.sql.includes('from "schedule_previews"') ? [built] : []
      },
      async db => {
        await publishPreview(db, actor, row.id, 0, clock)
      }
    )
    expect(resolved).deep.equals([
      ['p1', 'k1', 'k2'],
      ['p2', 'k3']
    ])
  })

  it('reads each fact once per key inside withRolesRead, and every time outside it', async () => {
    const reads: string[] = []
    const fact = async (db: unknown, key: string): Promise<string> =>
      await readOnce(db as Parameters<typeof readOnce>[0], key, async () => {
        reads.push(key)
        return `${key} read`
      })
    const transaction: object = {}
    const db = transaction as Parameters<typeof withRolesRead>[0]
    expect(await fact(db, 'teams:a:name')).equals('teams:a:name read')
    expect(await fact(db, 'teams:a:name')).equals('teams:a:name read')
    expect(reads).deep.equals(['teams:a:name', 'teams:a:name'])
    reads.length = 0
    await withRolesRead(db, async () => {
      expect(await fact(db, 'teams:a:name')).equals('teams:a:name read')
      expect(await fact(db, 'teams:a:name')).equals('teams:a:name read')
      expect(await fact(db, 'seasons:s:name')).equals('seasons:s:name read')
      // Another transaction reads for itself.
      await fact({}, 'teams:a:name')
    })
    expect(reads).deep.equals([
      'teams:a:name',
      'seasons:s:name',
      'teams:a:name'
    ])
    reads.length = 0
    // Nothing is kept once the work ends.
    await fact(db, 'teams:a:name')
    expect(reads).deep.equals(['teams:a:name'])
  })

  it('keeps what an outer withRolesRead read through an inner one, and after it', async () => {
    const reads: string[] = []
    const transaction: object = {}
    const db = transaction as Parameters<typeof withRolesRead>[0]
    const fact = async (key: string): Promise<string> =>
      await readOnce(db, key, async () => {
        reads.push(key)
        return key
      })
    await withRolesRead(db, async () => {
      await fact('teams:a:facts')
      expect(
        await withRolesRead(db, async () => {
          await fact('teams:a:facts')
          await fact('teams:b:facts')
          return 'inner'
        })
      ).equals('inner')
      await fact('teams:b:facts')
    })
    expect(reads).deep.equals(['teams:a:facts', 'teams:b:facts'])
  })
})
