import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import * as sessions from '../auth/sessions'
import * as chats from '../chat/dms'
import * as guard from '../groups/adminGuard'
import * as scoring from '../scoring/mergeConflicts'
import * as sync from '../socket/syncRevision'
import * as identities from '../users/survivors'
import { closeInto } from './people'

describe('inherited administrator merge precheck', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  for (const survivor of [true, false])
    it(`requires somebody other than the closing ancestor before any identity writes (survivor=${survivor})`, async () => {
      mock.method(
        identities,
        'survivorsOf',
        async (_db: unknown, ids: string[]) => new Map(ids.map(id => [id, id]))
      )
      mock.method(scoring, 'assertMergeScoringSafe', async () => undefined)
      mock.method(chats, 'mergeChats', async () => undefined)
      mock.method(sessions, 'signOutEverywhere', async () => undefined)
      mock.method(sync, 'noteScopeChange', () => undefined)
      mock.method(guard, 'effectiveAdminIds', async () =>
        survivor ? ['source', 'parent-admin'] : ['source']
      )
      let finalCheck = false
      mock.method(guard, 'requireAdministrator', async () => {
        finalCheck = true
      })
      let writes = 0
      await withQueryReplies(
        ({ sql, parameters }) => {
          if (/^(update|delete|insert)/.test(sql)) writes++
          if (sql.includes('with recursive up('))
            return (parameters[0] as string[]).map(id => ({
              start: id,
              survivor: id,
              id
            }))
          if (sql.includes('with recursive closed'))
            return [{ id: parameters[0] }]
          if (sql.startsWith('select "login_enabled"'))
            return [
              {
                login_enabled: true,
                disabled_at: null,
                merged_into: null,
                is_admin: false
              }
            ]
          if (sql.startsWith('select "id", "login_enabled"'))
            return [
              { id: 'source', login_enabled: true },
              { id: 'destination', login_enabled: true }
            ]
          if (sql.startsWith('select "scope_type", "scope_id"'))
            return [{ scope_type: 'team', scope_id: 'team' }]
          if (sql.startsWith('select "kind"')) return [{ kind: 'full' }]
          return []
        },
        async db => {
          const result = await closeInto(db, 'source', 'destination').catch(
            (e: unknown) => e
          )
          if (survivor) {
            expect(result).property('closed', true)
            expect(writes).greaterThan(0)
            expect(finalCheck).equals(true)
          } else {
            expect(result).property('code', 'conflict')
            expect(writes).equals(0)
            expect(finalCheck).equals(false)
          }
        }
      )
    })
})
