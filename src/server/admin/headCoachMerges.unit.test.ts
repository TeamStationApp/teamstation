import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import * as sessions from '../auth/sessions'
import * as chats from '../chat/dms'
import { mergeParents } from '../groups/teamMerge'
import * as scoring from '../scoring/mergeConflicts'
import * as sync from '../socket/syncRevision'
import * as identities from '../users/survivors'
import { closeInto } from './people'

describe('designation transfers in identity merges', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  for (const redirect of [false, true]) {
    it(`transfers only the closing subtree to an eligible direct coach (redirect=${redirect})`, async () => {
      mock.method(
        identities,
        'survivorsOf',
        async () => new Map([['destination', 'destination']])
      )
      mock.method(scoring, 'assertMergeScoringSafe', async () => undefined)
      mock.method(chats, 'mergeChats', async () => undefined)
      mock.method(sessions, 'signOutEverywhere', async () => undefined)
      mock.method(sync, 'noteScopeChange', () => undefined)
      let login = false
      let transferred = false
      await withQueryReplies(
        ({ sql, parameters }) => {
          if (
            sql.startsWith('select "merged_into"') &&
            parameters[0] === 'source'
          )
            return [{ merged_into: redirect ? 'previous' : null }]
          if (sql.includes('with recursive closed'))
            return [{ id: 'source' }, { id: 'descendant' }]
          if (sql.startsWith('select "login_enabled"'))
            return [
              {
                login_enabled: parameters[0] === 'source',
                merged_into:
                  redirect && parameters[0] === 'source' ? 'previous' : null
              }
            ]
          if (sql.startsWith('select "id", "login_enabled"'))
            return [
              { id: 'source', login_enabled: true },
              { id: 'destination', login_enabled: login }
            ]
          if (sql.startsWith('update "users" set "login_enabled"')) login = true
          if (sql.startsWith('update "scope_roles"')) {
            if (parameters[0] === false) {
              expect(parameters).includes('source')
              expect(parameters).not.includes('previous')
              if (redirect) expect(parameters).includes('descendant')
              return [{ scope_id: 'managed-team' }]
            }
            expect(login).equals(true)
            expect(sql).includes('"disabled_at" is null')
            expect(parameters).to.include.members([
              true,
              'managed-team',
              'destination',
              'team',
              'coach'
            ])
            transferred = true
          }
          return []
        },
        async db => {
          const result = await closeInto(db, 'source', 'destination')
          expect(result.closed).equals(true)
          expect(transferred).equals(true)
        }
      )
    })
  }

  for (const hasIncumbent of [true, false]) {
    it(`preserves the destination team’s incumbent when merging (occupied=${hasIncumbent})`, async () => {
      let transferred = false
      const source = { scope_id: 'source', user_id: 'coach' }
      await withQueryReplies(
        ({ sql, parameters }) => {
          if (sql.startsWith('select') && sql.includes('from "teams"'))
            return ['source', 'destination'].map(id => ({
              id,
              kind: 'full',
              league_id: 'league',
              merged_into: null
            }))
          if (sql.startsWith('select * from "scope_roles"'))
            return [
              {
                ...source,
                scope_type: 'team',
                role: 'coach',
                is_head_coach: true
              }
            ]
          if (sql.startsWith('insert into "scope_roles"'))
            expect(parameters).includes(false)
          if (sql.startsWith('select "scope_id", "user_id"'))
            return hasIncumbent
              ? [source, { scope_id: 'destination', user_id: 'other' }]
              : [source]
          if (sql.startsWith('update "scope_roles"')) {
            expect(parameters).to.include.members([
              true,
              'destination',
              'coach'
            ])
            transferred = true
          }
          return []
        },
        async db => {
          await mergeParents(db, 'source', 'destination', true)
          expect(transferred).equals(!hasIncumbent)
        }
      )
    })
  }
})
