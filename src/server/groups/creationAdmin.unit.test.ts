import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { CreateGroup, GroupRef } from '../../common/groupCreation'
import { withQueryReplies } from '../../test/queryReplies'
import type { Actor } from '../auth/sessions'
import type { MediaContext } from '../media/mediaContext'
import * as sync from '../socket/syncRevision'
import { createTeam } from '../teams/createTeam'
import { createGroup } from './createGroup'
import * as inherited from './inheritedAdmins'
import * as rights from './rights'

const media: MediaContext = {
  mediaRoot: '',
  ffmpegPath: '',
  mediaSecret: '',
  publicUrl: 'https://example.test',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: ''
  }
}

describe('creator administrator grants', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  for (const covered of [true, false]) {
    it(`grants modern creators only when uncovered (covered=${covered})`, async () => {
      mock.method(
        rights,
        'currentActor',
        async (_db: unknown, actor: Actor) => actor
      )
      mock.method(rights, 'requireGroupAdmin', async () => undefined)
      mock.method(sync, 'noteScopeChange', () => undefined)
      const checked: string[] = []
      mock.method(
        inherited,
        'inheritedAdminIds',
        async (
          _db: unknown,
          ref: GroupRef,
          options?: { userId?: string; durable?: boolean }
        ) => {
          expect(options).deep.equals({ userId: 'creator', durable: true })
          checked.push(ref.kind)
          return covered && ref.kind !== 'league' ? ['creator'] : []
        }
      )
      let grants = 0
      await withQueryReplies(
        ({ sql }) => {
          if (sql.includes('"onboarding_step"'))
            return [{ onboarding_step: 'complete' }]
          if (sql.startsWith('select "league_id"'))
            return [{ league_id: 'league' }]
          if (sql.startsWith('insert into "scope_roles"')) grants++
          return []
        },
        async db => {
          for (const kind of ['team', 'season', 'league'] as const) {
            const body: CreateGroup = {
              kind,
              name: 'Demo Group',
              idempotencyKey: `unit-${kind}`,
              startsOn: '2027-03-01',
              endsOn: '2027-05-31',
              timezone: 'UTC',
              ...(kind === 'team'
                ? { parent: { kind: 'season', id: 'season' } }
                : kind === 'season'
                  ? { parent: { kind: 'league', id: 'league' } }
                  : {})
            }
            await createGroup(
              db,
              { userId: 'creator', isAdmin: false, scopes: [] },
              body,
              media
            )
          }
        }
      )
      expect(checked).deep.equals(['team', 'season', 'league'])
      expect(grants).equals(covered ? 1 : 3)
    })
    it(`grants a new legacy season before checking team inheritance (covered=${covered})`, async () => {
      mock.method(sync, 'noteScopeChange', () => undefined)
      const grants: string[] = []
      mock.method(
        inherited,
        'inheritedAdminIds',
        async (_db: unknown, ref: GroupRef, options?: { userId?: string }) => {
          expect(options).deep.equals({ userId: 'creator' })
          expect(ref.kind).equals('team')
          expect(grants).deep.equals(['season'])
          return covered ? ['creator'] : []
        }
      )
      let owners = 0
      await withQueryReplies(
        ({ sql, parameters }) => {
          if (sql.includes('from "users"'))
            return [
              {
                is_admin: false,
                login_enabled: true,
                disabled_at: null,
                merged_into: null
              }
            ]
          if (sql.startsWith('insert into "scope_roles"'))
            grants.push(parameters.includes('season') ? 'season' : 'team')
          if (sql.startsWith('insert into "memberships"')) {
            expect(parameters).includes('owner')
            owners++
          }
          return []
        },
        async db => {
          await createTeam(
            db,
            {
              name: 'Demo Team',
              season: { name: 'Demo Season', year: 2027 },
              externalIds: []
            },
            { userId: 'creator', isAdmin: false }
          )
        }
      )
      expect(grants).deep.equals(covered ? ['season'] : ['season', 'team'])
      expect(owners).equals(1)
    })
  }
})
