import assert from 'node:assert/strict'
import { mock } from 'node:test'

import { expect } from 'chai'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type QueryStep, withQueryReplies } from '../../test/queryReplies'
import * as identities from '../admin/people'
import * as guard from '../groups/adminGuard'
import * as rights from '../groups/rights'
import * as grants from '../invites/grants'
import * as roleChanges from '../invites/people'
import * as sync from '../socket/syncRevision'
import * as designation from '../teams/teamHeadCoach'
import * as roster from '../teams/teamRoster'
import { peopleRoutes } from './people'

const actor = { userId: userIdOfGumbo(1), isAdmin: false, scopes: [] }
const incoming = userIdOfGumbo(2)
const incumbent = userIdOfGumbo(3)
const media = {
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}
const url = `/manage/team/team/people/${incoming}/roles/headCoach`

describe('team designation route decisions', () => {
  let listed: boolean
  let roles: string[]
  beforeEach(() => {
    roles = ['coach']
    listed = true
    mock.method(rights, 'currentActor', async () => actor)
    mock.method(rights, 'requirePeopleManager', async () => undefined)
    mock.method(roster, 'onPeopleList', async () => listed)
    mock.method(guard, 'refuseRoleWhileHeld', async () => undefined)
    mock.method(grants, 'canHoldRoles', async () => true)
    mock.method(grants, 'grantAt', async () => [])
    mock.method(grants, 'heldAt', async () => ({
      member: true,
      roles
    }))
    mock.method(designation, 'teamHeadCoach', async () => ({
      userId: incumbent,
      grantUserId: incumbent,
      name: 'Previous coach'
    }))
    mock.method(sync, 'noteScopeChange', () => undefined)
  })
  afterEach(() => {
    mock.restoreAll()
  })
  for (const confirmed of [true, false]) {
    it(`requires current confirmation before replacing the incumbent (confirmed=${confirmed})`, async () => {
      const auth = mock.method(
        guard,
        'authorizePersonChange',
        async () => undefined
      )
      await withQueryReplies(
        [
          ['pg_advisory_xact_lock', []],
          ...(confirmed
            ? ([
                [
                  'update "scope_roles"',
                  [],
                  q => expect(q.parameters).to.include(false)
                ],
                [
                  'update "scope_roles"',
                  [],
                  q =>
                    expect(q.parameters).to.include.members([
                      true,
                      incoming,
                      'team',
                      'coach'
                    ])
                ]
              ] as QueryStep[])
            : [])
        ],
        async db => {
          const router = peopleRoutes(db, media)
          const response = new Promise((resolve, reject) =>
            router(
              {
                url,
                method: 'PUT',
                actor,
                body: confirmed ? { expectedHeadCoach: incumbent } : {}
              } as unknown as Request,
              { locals: {}, json: resolve } as unknown as Response,
              reject
            )
          )
          if (confirmed) expect(await response).includes({ userId: incoming })
          else await assert.rejects(response, /confirm the replacement/)
          expect(auth.mock.calls.map(call => call.arguments[2])).deep.equals(
            confirmed ? [incoming, incumbent] : [incoming]
          )
        }
      )
    })
  }
  it('an unlisted person remains undiscoverable even when they are a node administrator', async () => {
    listed = false
    const auth = mock.method(guard, 'authorizePersonChange', async () => {
      throw new Error('protected admin')
    })
    for (const method of ['PUT', 'DELETE']) {
      const steps: QueryStep[] = [['pg_advisory_xact_lock', []]]
      if (method === 'DELETE') steps.push(['from "users"', [{ id: incoming }]])
      await withQueryReplies(steps, async db => {
        const router = peopleRoutes(db, media)
        const result = new Promise((resolve, reject) =>
          router(
            {
              url: method === 'PUT' ? url.replace('headCoach', 'member') : url,
              method,
              actor,
              body: {}
            } as unknown as Request,
            { locals: {}, json: resolve } as unknown as Response,
            reject
          )
        )
        await assert.rejects(result, { status: 404 })
        expect(auth.mock.callCount()).equals(0)
      })
    }
  })
  for (const target of ['member', 'assistant', 'self']) {
    it(`reads the locked roles before removing ${target}`, async () => {
      roles = ['coach', 'assistant']
      const set = mock.method(roleChanges, 'setScopeRoles', async () => {
        roles = ['coach']
        return roles
      })
      const gone = mock.method(roleChanges, 'removeFromScope', async () => {
        roles = []
        return { removed: true }
      })
      const steps: QueryStep[] = [['pg_advisory_xact_lock', []]]
      if (target === 'self') steps.unshift(['from "teams"', [{ id: 'team' }]])
      else steps.push(['from "users"', [{ id: incoming }]])
      await withQueryReplies(steps, async db => {
        const router = peopleRoutes(db, media)
        const path =
          target === 'self'
            ? '/me/groups/team/team/roles/assistant'
            : url.replace('headCoach', target)
        const result = await new Promise((resolve, reject) =>
          router(
            { url: path, method: 'DELETE', actor } as unknown as Request,
            { locals: {}, json: resolve } as unknown as Response,
            reject
          )
        )
        expect(result).deep.includes({
          roles: target === 'member' ? [] : ['coach']
        })
        if (target === 'member') expect(gone.mock.callCount()).equals(1)
        else
          expect(set.mock.calls[0].arguments[4]).deep.equals({
            admin: false,
            flags: ['coach']
          })
      })
    })
  }
  it('clears the designation on aliases without deleting Coach grants', async () => {
    mock.method(guard, 'authorizePersonChange', async () => undefined)
    mock.method(identities, 'onePerson', async () => ({
      userId: incoming,
      userIds: [incoming, 'alias']
    }))
    await withQueryReplies(
      [
        ['pg_advisory_xact_lock', []],
        ['from "users"', [{ id: incoming }]],
        [
          'update "scope_roles"',
          [],
          query =>
            expect(query.parameters).to.include.members([
              false,
              incoming,
              'alias'
            ])
        ]
      ],
      async db => {
        const router = peopleRoutes(db, media)
        const response = await new Promise((resolve, reject) =>
          router(
            { url, method: 'DELETE', actor } as unknown as Request,
            { locals: {}, json: resolve } as unknown as Response,
            reject
          )
        )
        expect(response).includes({ userId: incoming })
      }
    )
  })
})
