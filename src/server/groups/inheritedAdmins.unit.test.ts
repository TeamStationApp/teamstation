import { expect } from 'chai'
import { describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import {
  directAdminIds,
  effectiveAdminIds,
  requireAdministrator
} from './adminGuard'
import { inheritedAdminIds } from './inheritedAdmins'
import {
  analyzeOwnership,
  type OwnershipInput,
  ownershipPreflight
} from './ownershipPreflight'

describe('organizational administrator coverage', () => {
  it('has no inherited league authority and no implicit site-wide fallback', async () => {
    await withQueryReplies([], async db => {
      expect(
        await inheritedAdminIds(db, { kind: 'league', id: 'l' })
      ).deep.equals([])
    })
    await withQueryReplies(
      [
        ['permission_parents', []],
        ['from "teams"', [{ league_id: 'l' }]],
        [
          'scope_roles',
          [],
          q => {
            expect(q.sql).includes('"users"."login_enabled" =')
            expect(q.sql).includes('"users"."disabled_at" is null')
            expect(q.sql).includes('"users"."merged_into" is null')
            expect(q.sql).not.includes('is_admin')
            expect(q.parameters).includes('person')
          }
        ]
      ],
      async db => {
        expect(
          await inheritedAdminIds(
            db,
            { kind: 'team', id: 't' },
            { userId: 'person' }
          )
        ).deep.equals([])
      }
    )
    await withQueryReplies(
      [
        ['permission_parents', []],
        ['from "teams"', [{ league_id: null }]]
      ],
      async db => {
        expect(
          await inheritedAdminIds(db, { kind: 'team', id: 'standalone' })
        ).deep.equals([])
      }
    )
  })
  it("reads only a team's league, permission-parent seasons and their leagues", async () => {
    await withQueryReplies(
      [
        [
          'permission_parents',
          [
            { id: 's', league_id: 'l' },
            { id: 'free', league_id: null }
          ],
          q => {
            expect(q.sql).includes('season_team_parents')
            expect(q.sql).includes('season_teams')
            expect(q.parameters).includes('creation.hierarchyReady')
            expect(q.parameters).includes('t')
          }
        ],
        ['from "teams"', [{ league_id: 'direct' }]],
        [
          'scope_roles',
          [{ user_id: 'b' }, { user_id: 'a' }],
          q => {
            expect(q.sql).includes('select distinct')
            expect(q.parameters).to.include.members([
              'league',
              'season',
              'admin'
            ])
            expect(q.parameters).to.deep.include(['direct', 'l'])
            expect(q.parameters).to.deep.include(['s', 'free'])
          }
        ]
      ],
      async db => {
        expect(
          await inheritedAdminIds(db, { kind: 'team', id: 't' })
        ).deep.equals(['a', 'b'])
      }
    )
  })
  it("uses only the league's grants to inherit a season", async () => {
    await withQueryReplies(
      [
        ['from "seasons"', [{ league_id: 'l' }]],
        [
          'scope_roles',
          [{ user_id: 'a' }],
          q => {
            expect(q.parameters).includes('league')
            expect(q.parameters).not.includes('season')
            expect(q.parameters).to.deep.include(['l'])
          }
        ]
      ],
      async db => {
        expect(
          await inheritedAdminIds(db, { kind: 'season', id: 's' })
        ).deep.equals(['a'])
      }
    )
    await withQueryReplies([['from "seasons"', []]], async db => {
      expect(
        await inheritedAdminIds(db, { kind: 'season', id: 'free' })
      ).deep.equals([])
    })
  })
  it('trusts inherited team coverage only after the ownership cutover', async () => {
    for (const value of [undefined, false]) {
      await withQueryReplies(
        [['system_settings', value == null ? [] : [{ value }]]],
        async db => {
          expect(
            await inheritedAdminIds(
              db,
              { kind: 'team', id: 't' },
              { userId: 'person', durable: true }
            )
          ).deep.equals([])
        }
      )
    }
    await withQueryReplies(
      [
        ['system_settings', [{ value: true }]],
        ['permission_parents', []],
        ['from "teams"', [{ league_id: 'l' }]],
        ['scope_roles', [{ user_id: 'person' }]]
      ],
      async db => {
        expect(
          await inheritedAdminIds(
            db,
            { kind: 'team', id: 't' },
            { userId: 'person', durable: true }
          )
        ).deep.equals(['person'])
      }
    )
    await withQueryReplies(
      [
        ['from "seasons"', [{ league_id: 'l' }]],
        ['scope_roles', [{ user_id: 'person' }]]
      ],
      async db => {
        expect(
          await inheritedAdminIds(
            db,
            { kind: 'season', id: 's' },
            { userId: 'person', durable: true }
          )
        ).deep.equals(['person'])
      }
    )
  })
  it('combines direct and inherited people and active owner memberships', async () => {
    await withQueryReplies(
      [
        ['scope_roles', [{ id: 'a' }]],
        ['memberships', [{ id: 'a' }, { id: 'owner' }]],
        ['system_settings', [{ value: true }]],
        ['permission_parents', [{ id: 's', league_id: null }]],
        ['from "teams"', [{ league_id: null }]],
        ['scope_roles', [{ user_id: 'a' }]]
      ],
      async db => {
        expect(
          await effectiveAdminIds(db, { kind: 'team', id: 't' })
        ).deep.equals(['a', 'owner'])
      }
    )
    await withQueryReplies([['scope_roles', [{ id: 'a' }]]], async db => {
      expect(await directAdminIds(db, { kind: 'league', id: 'l' })).deep.equals(
        ['a']
      )
    })
  })
  it('exempts placeholders, accepts inherited coverage, and refuses orphaning', async () => {
    await withQueryReplies([['teams', [{ kind: 'external' }]]], async db => {
      await requireAdministrator(db, { kind: 'team', id: 'x' })
    })
    await withQueryReplies(
      [
        ['teams', [{ kind: 'full' }]],
        ['scope_roles', []],
        ['memberships', []],
        ['system_settings', [{ value: true }]],
        ['permission_parents', [{ id: 's', league_id: null }]],
        ['from "teams"', [{ league_id: null }]],
        ['scope_roles', [{ user_id: 'a' }]]
      ],
      async db => {
        await requireAdministrator(db, { kind: 'team', id: 't' })
      }
    )
    // Before the cutover a team's inherited coverage is not counted.
    await withQueryReplies(
      [
        ['teams', [{ kind: 'full' }]],
        ['scope_roles', []],
        ['memberships', []],
        ['system_settings', []]
      ],
      async db => {
        expect(
          await requireAdministrator(db, { kind: 'team', id: 't' }).catch(
            (e: unknown) => e
          )
        ).property('code', 'conflict')
      }
    )
    await withQueryReplies([['scope_roles', []]], async db => {
      expect(
        await requireAdministrator(db, { kind: 'league', id: 'l' }).catch(
          (e: unknown) => e
        )
      ).property('code', 'conflict')
    })
    await withQueryReplies([['scope_roles', []]], async db => {
      expect(
        await requireAdministrator(
          db,
          { kind: 'league', id: 'l' },
          'Named cause'
        ).catch((e: unknown) => e)
      ).property('message', 'Named cause')
    })
  })
})

describe('selected ownership coverage', () => {
  const fixture = (): OwnershipInput => ({
    teams: [{ id: 't', kind: 'full' }],
    seasons: [{ id: 's', leagueId: 'l' }],
    leagues: [{ id: 'l' }],
    memberships: [{ teamId: 't', seasonId: 's' }],
    directAdmins: [{ kind: 'league', id: 'l' }]
  })
  it('accepts inherited-only children and refuses a selection that removes their authority', () => {
    const input = fixture()
    expect(analyzeOwnership(input).ready).equals(true)
    expect(
      analyzeOwnership(input, [{ teamId: 't', parentSeasonIds: [] }]).conflicts
    ).deep.equals([
      { kind: 'team', id: 't', reason: 'Assign an active administrator' }
    ])
    input.teams[0].leagueId = 'l'
    expect(
      analyzeOwnership(input, [{ teamId: 't', parentSeasonIds: [] }]).ready
    ).equals(true)
  })
  it('reports a rejected parent decision once, without a coverage conflict', () => {
    expect(
      analyzeOwnership(fixture(), [
        { teamId: 't', parentSeasonIds: ['s', 's'] }
      ]).conflicts
    ).deep.equals([
      { kind: 'team', id: 't', reason: 'Duplicate parent decision' }
    ])
  })
  it('uses the selected league instead of the replaced direct league', () => {
    const input = fixture()
    input.teams[0].leagueId = 'l'
    input.seasons[0].leagueId = null
    expect(analyzeOwnership(input).ready).equals(false)
    input.directAdmins.push({ kind: 'season', id: 's' })
    expect(analyzeOwnership(input).ready).equals(true)
    input.teams.push({ id: 'orphan', kind: 'full' })
    expect(analyzeOwnership(input).ready).equals(false)
  })
})

describe('ownership preflight reads', () => {
  /** Replies for one preflight; `read` records which parent table it read. */
  function replies(ready: boolean, read: string[]) {
    return (query: { sql: string }): unknown[] => {
      const text = query.sql
      if (
        /^(begin|commit|rollback)/.test(text) ||
        text.includes('pg_advisory_xact_lock') ||
        text.includes('pg_notify')
      )
        return []
      if (text.includes('from "system_settings"'))
        return ready ? [{ value: true }] : []
      for (const table of ['season_team_parents', 'season_teams'])
        if (text.includes(`from "${table}"`)) {
          read.push(table)
          return [{ team_id: 't', season_id: 's' }]
        }
      if (text.includes('from "teams"'))
        return [
          {
            id: 't',
            kind: 'full',
            league_id: null,
            custodian_id: null,
            custodian_type: null
          }
        ]
      if (text.includes('from "seasons"')) return [{ id: 's', league_id: 'l' }]
      if (text.includes('from "leagues"')) return [{ id: 'l' }]
      if (text.includes('from "scope_roles"'))
        return [{ scope_type: 'league', scope_id: 'l' }]
      if (text.includes('from "memberships"')) return []
      throw new Error(`Unexpected query: ${text}`)
    }
  }
  it('reads competition seasons before the cutover and reports the parents it would choose', async () => {
    const read: string[] = []
    await withQueryReplies(replies(false, read), async db => {
      const report = await ownershipPreflight(db, { dryRun: true })
      expect(report.ready).equals(true)
      expect(report.parents).deep.equals([
        { teamId: 't', seasonId: 's', leagueId: 'l' }
      ])
    })
    expect(read).deep.equals(['season_teams'])
  })
  it('reads the chosen parents after the cutover and applies nothing again', async () => {
    const read: string[] = []
    await withQueryReplies(replies(true, read), async db => {
      expect(await ownershipPreflight(db, { dryRun: false })).property(
        'alreadyApplied',
        true
      )
    })
    expect(read).deep.equals(['season_team_parents'])
  })
})
