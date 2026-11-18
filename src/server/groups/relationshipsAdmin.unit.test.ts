import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { GroupRef } from '../../common/groupCreation'
import { withQueryReplies } from '../../test/queryReplies'
import type { Actor } from '../auth/sessions'
import * as sync from '../socket/syncRevision'
import * as guard from './adminGuard'
import { applyParents, previewParents } from './relationships'
import * as rights from './rights'

describe('administrator survival across parent batches', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  for (const covered of [true, false])
    it(`checks affected administered children and descendants after the complete move (covered=${covered})`, async () => {
      mock.method(
        rights,
        'currentActor',
        async (_db: unknown, actor: Actor) => actor
      )
      mock.method(rights, 'canAdminister', async () => true)
      mock.method(sync, 'noteScopeChange', () => undefined)
      const checked: string[] = []
      const changed: string[] = []
      mock.method(
        guard,
        'effectiveAdminIds',
        async (_db: unknown, ref: GroupRef) =>
          ref.kind === 'season' || covered ? ['admin'] : []
      )
      mock.method(
        guard,
        'requireAdministrator',
        async (_db: unknown, ref: GroupRef) => {
          expect(changed).includes('new-league')
          checked.push(ref.id)
        }
      )
      await withQueryReplies(
        ({ sql, parameters }) => {
          if (sql.startsWith('select "id", "league_id" from "teams"'))
            return [
              { id: 'team', league_id: 'old-league' },
              { id: 'unrelated', league_id: null }
            ]
          if (sql.startsWith('select "id", "league_id", "starts_on"'))
            return [
              {
                id: 'season',
                league_id: 'old-league',
                starts_on: null,
                ends_on: null,
                timezone: 'UTC'
              }
            ]
          if (sql.startsWith('select "id" from "leagues"'))
            return [{ id: 'old-league' }, { id: 'new-league' }]
          if (sql.startsWith('select "team_id", "season_id"'))
            return [{ team_id: 'team', season_id: 'season' }]
          if (sql.startsWith('select "name"')) return [{ name: 'Demo Group' }]
          if (sql.startsWith('update')) changed.push(String(parameters[0]))
          return []
        },
        async db => {
          const preview = await previewParents(db, [
            {
              child: { kind: 'season', id: 'season' },
              parent: { kind: 'league', id: 'old-league' },
              operation: 'detach'
            },
            {
              child: { kind: 'season', id: 'season' },
              parent: { kind: 'league', id: 'new-league' },
              operation: 'attach'
            }
          ])
          await applyParents(
            db,
            [{ userId: 'admin', isAdmin: false, scopes: [] }],
            preview
          )
        }
      )
      expect(checked.sort()).deep.equals(
        covered ? ['season', 'team'] : ['season']
      )
    })
})
