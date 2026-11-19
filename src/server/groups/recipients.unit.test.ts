import { mock } from 'node:test'

import { expect } from 'chai'
import type { CompiledQuery } from 'kysely'
import { afterEach, describe, it } from 'mocha'

import { ROLES } from '../../common/roles'
import { withQueryReplies } from '../../test/queryReplies'
import * as access from '../access'
import { type RoleScopes, roleScopesForUsers } from '../access'
import { accountReadOnce, withRolesRead } from '../db/readOnce'
import {
  administers,
  adminRecipients,
  canAdminister,
  canScheduleFor,
  currentActor,
  requireGroupAdmin,
  requireScheduler,
  schedulesFor,
  schedulingRecipients
} from './rights'

/** A person's roles: `admin` and `coach` over the groups named. */
function scopes(
  held: { admin?: string[]; coach?: string[]; isAdmin?: boolean } = {}
): RoleScopes {
  const set = (ids: string[] = []): RoleScopes['admin'] => ({
    leagueIds: new Set(ids.filter(id => id.startsWith('lea'))),
    seasonIds: new Set(ids.filter(id => id.startsWith('sea'))),
    teamIds: new Set(ids.filter(id => id.startsWith('tem')))
  })
  const out = Object.fromEntries(
    ROLES.map(role => [role, set()])
  ) as unknown as RoleScopes
  out.admin = set(held.admin)
  out.coach = set(held.coach)
  out.isAdmin = held.isAdmin === true
  return out
}

const TEAMS: Record<string, unknown> = {
  // A placeholder team its league holds.
  tem_held: {
    kind: 'external',
    custodian_type: 'league',
    custodian_id: 'lea_a'
  },
  // A placeholder nobody holds.
  tem_loose: { kind: 'external', custodian_type: null, custodian_id: null },
  // A placeholder held by a placeholder, which nobody runs.
  tem_nested: {
    kind: 'external',
    custodian_type: 'team',
    custodian_id: 'tem_loose'
  },
  // A placeholder held by a full team, whose admins run it.
  tem_kept: {
    kind: 'external',
    custodian_type: 'team',
    custodian_id: 'tem_full'
  },
  tem_full: { kind: 'full', custodian_type: null, custodian_id: null },
  tem_loose_kind: { kind: 'external' }
}

/** The candidate queries a recipient list reads, and each team. */
function replies(seen: string[]): (query: CompiledQuery) => unknown[] {
  return query => {
    seen.push(query.sql)
    if (query.sql.includes('from "scope_roles"'))
      return [{ user_id: 'u_league' }, { user_id: 'u_coach' }]
    if (query.sql.includes('from "memberships"'))
      return [{ user_id: 'u_owner' }]
    if (query.sql.includes('from "users"'))
      return ['u_site', 'u_league', 'u_coach', 'u_owner', 'u_gone'].map(id => ({
        id,
        is_admin: id === 'u_site'
      }))
    if (query.sql.includes('from "teams"'))
      return [TEAMS[String(query.parameters[0])]].filter(row => row != null)
    throw new Error(query.sql)
  }
}

describe('recipients and roles read once', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  const held = new Map<string, RoleScopes>([
    ['u_site', scopes({ isAdmin: true })],
    ['u_league', scopes({ admin: ['lea_a'] })],
    ['u_coach', scopes({ coach: ['tem_coached'] })],
    ['u_owner', scopes({ admin: ['tem_full'] })]
  ])
  const stand = (): void => {
    mock.method(
      access,
      'roleScopesForUsers',
      async (_db: unknown, ids: string[]) =>
        new Map(ids.filter(id => held.has(id)).map(id => [id, held.get(id)!]))
    )
  }

  it('names each group’s administrators from roles read once, a placeholder’s through its custodian', async () => {
    stand()
    const seen: string[] = []
    await withQueryReplies(replies(seen), async db => {
      expect(
        await adminRecipients(db, [{ kind: 'league', id: 'lea_a' }])
      ).deep.equals(['u_site', 'u_league'])
      expect(
        await adminRecipients(db, [{ kind: 'team', id: 'tem_held' }])
      ).deep.equals(['u_site', 'u_league'])
      // Nobody holds it, or only a placeholder does: nobody administers it,
      // a site admin neither, as canAdminister has it.
      for (const id of ['tem_loose', 'tem_nested'])
        expect(await adminRecipients(db, [{ kind: 'team', id }])).deep.equals(
          []
        )
      // A full team holding it gives it its own administrators.
      expect(
        await adminRecipients(db, [{ kind: 'team', id: 'tem_kept' }])
      ).deep.equals(['u_site', 'u_owner'])
      // A season nobody named runs, and a team in no list.
      expect(
        await adminRecipients(db, [
          { kind: 'season', id: 'sea_a' },
          { kind: 'team', id: 'tem_other' }
        ])
      ).deep.equals(['u_site'])
    })
    // Roles came from one batched read per list, not one per candidate.
    expect(seen.filter(sql => sql.includes('from "users"'))).lengthOf(6)
  })

  it('names a team’s coaches among those who schedule for it, but not a league’s', async () => {
    stand()
    await withQueryReplies(replies([]), async db => {
      expect(
        await schedulingRecipients(db, [{ kind: 'team', id: 'tem_coached' }])
      ).deep.equals(['u_site', 'u_coach'])
      expect(
        await schedulingRecipients(db, [{ kind: 'league', id: 'lea_a' }])
      ).deep.equals(['u_site', 'u_league'])
    })
  })

  it('gives a placeholder nobody administers to nobody, a site admin neither, but to its coach to schedule', () => {
    const site = scopes({ isAdmin: true })
    const coach = scopes({ coach: ['tem_loose'] })
    const loose = { kind: 'team', id: 'tem_loose' } as const
    expect(administers(site, null)).equals(false)
    expect(schedulesFor(site, loose, null)).equals(false)
    expect(schedulesFor(coach, loose, null)).equals(true)
    // A league nobody's target names is a site admin's as ever.
    expect(administers(site, { kind: 'league', id: 'lea_a' })).equals(true)
  })

  it('names the same recipients as asking canAdminister and canScheduleFor of each candidate', async () => {
    const people = new Map<string, RoleScopes>([
      ['u_site', scopes({ isAdmin: true })],
      ['u_league', scopes({ admin: ['lea_a'] })],
      ['u_coach', scopes({ coach: ['tem_loose', 'tem_coached'] })],
      ['u_owner', scopes({ admin: ['tem_full'] })]
    ])
    mock.method(
      access,
      'roleScopesForUsers',
      async (_db: unknown, ids: string[]) =>
        new Map(
          ids.filter(id => people.has(id)).map(id => [id, people.get(id)!])
        )
    )
    mock.method(access, 'roleScopes', async (_db: unknown, id: string) =>
      people.get(id)!
    )
    mock.method(
      access,
      'adminScopes',
      async (_db: unknown, id: string, isAdmin: boolean) => ({
        ...people.get(id)!.admin,
        isAdmin
      })
    )
    const ids = [...people.keys()]
    const answer = (query: CompiledQuery): unknown[] => {
      // The actor's own account, read by canAdminister.
      if (query.sql.startsWith('select "is_admin"'))
        return [
          {
            is_admin: query.parameters[0] === 'u_site',
            disabled_at: null,
            merged_into: null,
            login_enabled: true
          }
        ]
      if (query.sql.includes('from "scope_roles"'))
        return [{ user_id: 'u_league' }, { user_id: 'u_coach' }]
      if (query.sql.includes('from "memberships"'))
        return [{ user_id: 'u_owner' }]
      if (query.sql.includes('from "users"'))
        return ids.map(id => ({ id, is_admin: id === 'u_site' }))
      if (query.sql.includes('from "teams"'))
        return [TEAMS[String(query.parameters[0])]].filter(row => row != null)
      throw new Error(query.sql)
    }
    const groups = [
      ...Object.keys(TEAMS).map(id => ({ kind: 'team', id }) as const),
      { kind: 'team', id: 'tem_coached' } as const,
      { kind: 'league', id: 'lea_a' } as const,
      { kind: 'season', id: 'sea_a' } as const
    ]
    await withQueryReplies(answer, async db => {
      for (const group of groups) {
        const actor = (
          userId: string
        ): Parameters<typeof canAdminister>[1] => ({
          userId,
          isAdmin: userId === 'u_site',
          scopes: []
        })
        const oneByOne = async (
          check: typeof canAdminister
        ): Promise<string[]> => {
          const out: string[] = []
          for (const id of ids)
            if (await check(db, actor(id), group)) out.push(id)
          return out
        }
        expect(await adminRecipients(db, [group]), group.id).deep.equals(
          await oneByOne(canAdminister)
        )
        expect(await schedulingRecipients(db, [group]), group.id).deep.equals(
          await oneByOne(canScheduleFor)
        )
      }
      // The orphaned placeholder is its coach's to schedule, and nobody's
      // to administer, with a site admin present.
      expect(
        await schedulingRecipients(db, [{ kind: 'team', id: 'tem_loose' }])
      ).deep.equals(['u_coach'])
      expect(
        await adminRecipients(db, [{ kind: 'team', id: 'tem_loose' }])
      ).deep.equals([])
    })
  })

  it('reads each person’s roles and account once inside withRolesRead, and every time outside it', async () => {
    const seen: string[] = []
    await withQueryReplies(
      query => {
        seen.push(query.sql)
        if (query.sql.includes('from "users"'))
          return [
            {
              id: 'u_a',
              is_admin: true,
              // The roles' read finds the person disabled; the actor's
              // own read finds them signed in.
              disabled_at: query.sql.includes('"login_enabled"')
                ? null
                : new Date(0),
              merged_into: null,
              login_enabled: true
            }
          ]
        throw new Error(query.sql)
      },
      async db => {
        // A disabled person holds nothing, read alone or with others.
        const first = await roleScopesForUsers(db, ['u_a'])
        expect(first.get('u_a')?.isAdmin).equals(false)
        await roleScopesForUsers(db, ['u_a'])
        expect(seen).lengthOf(2)
        let reads = 0
        const read = async (): Promise<string> => `read ${++reads}`
        expect(await accountReadOnce(db, 'u_b', read)).equals('read 1')
        expect(await accountReadOnce(db, 'u_b', read)).equals('read 2')
        const answer = await withRolesRead(db, async () => {
          await roleScopesForUsers(db, ['u_a'])
          const again = await roleScopesForUsers(db, ['u_a', 'u_a'])
          expect([...again.keys()]).deep.equals(['u_a'])
          expect(await accountReadOnce(db, 'u_b', read)).equals('read 3')
          expect(await accountReadOnce(db, 'u_b', read)).equals('read 3')
          // The actor's own account too.
          await currentActor(db, { userId: 'u_a', isAdmin: false, scopes: [] })
          await currentActor(db, { userId: 'u_a', isAdmin: false, scopes: [] })
          return 'done'
        })
        expect(answer).equals('done')
        // One read of the roles and one of the actor's account inside.
        expect(seen).lengthOf(4)
        // And none kept after it.
        await roleScopesForUsers(db, ['u_a'])
        expect(seen).lengthOf(5)
        expect(await accountReadOnce(db, 'u_b', read)).equals('read 4')
      }
    )
  })

  it('refuses a group that is gone, and reads that it is there once inside withRolesRead', async () => {
    const held = scopes({ admin: ['sea_kept', 'tem_full'] })
    mock.method(access, 'roleScopes', async () => held)
    mock.method(access, 'adminScopes', async () => ({
      ...held.admin,
      isAdmin: false
    }))
    const exists: string[] = []
    const replies = (query: CompiledQuery): unknown[] => {
      if (query.sql.includes('from "users"'))
        return [
          {
            is_admin: false,
            disabled_at: null,
            merged_into: null,
            login_enabled: true
          }
        ]
      if (query.sql.startsWith('select "id" from')) {
        exists.push(String(query.parameters[0]))
        return String(query.parameters[0]).includes('gone')
          ? []
          : [{ id: query.parameters[0] }]
      }
      if (query.sql.includes('from "teams"'))
        return [TEAMS[String(query.parameters[0])]].filter(row => row != null)
      throw new Error(query.sql)
    }
    const actor = { userId: 'u_a', isAdmin: false, scopes: [] }
    await withQueryReplies(replies, async db => {
      await withRolesRead(db, async () => {
        await requireScheduler(db, actor, { kind: 'season', id: 'sea_kept' })
        await requireScheduler(db, actor, { kind: 'season', id: 'sea_kept' })
        await requireGroupAdmin(db, actor, { kind: 'team', id: 'tem_full' })
        await requireGroupAdmin(db, actor, { kind: 'team', id: 'tem_full' })
      })
      expect(exists).deep.equals(['sea_kept', 'tem_full'])
      let refused = ''
      try {
        await requireScheduler(db, actor, { kind: 'team', id: 'tem_gone' })
      } catch (error) {
        refused = (error as Error).message
      }
      expect(refused).not.equal('')
      refused = ''
      try {
        await requireGroupAdmin(db, actor, { kind: 'league', id: 'lea_gone' })
      } catch (error) {
        refused = (error as Error).message
      }
      expect(refused).not.equal('')
      // Another's season is not this person's to schedule for.
      refused = ''
      try {
        await requireScheduler(db, actor, { kind: 'season', id: 'sea_other' })
      } catch (error) {
        refused = (error as Error).message
      }
      expect(refused).includes('Only an administrator')
      // A placeholder held by a full team is its admins'; one held by a
      // placeholder is nobody's.
      expect(
        await canAdminister(db, actor, { kind: 'team', id: 'tem_kept' })
      ).equals(true)
      expect(
        await canAdminister(db, actor, { kind: 'team', id: 'tem_nested' })
      ).equals(false)
      expect(
        await canAdminister(db, actor, { kind: 'team', id: 'tem_loose' })
      ).equals(false)
    })
  })
})
