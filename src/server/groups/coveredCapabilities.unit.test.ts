import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type QueryStep, withQueryReplies } from '../../test/queryReplies'
import { moderatorsOf } from '../chat/listing'
import { atomic } from '../db/atomic'
import { mayScheduleIn, scheduleRights } from '../schedule/scheduleGames'
import { decidePlayerAdd, playerAddApprovers } from './noticePolicy'
import type { StoredRequest } from './requests'

function replies(userIds: string[]): QueryStep[] {
  return [
    [
      'from "users"',
      userIds.map(id => ({
        id,
        is_admin: false,
        disabled_at: null,
        merged_into: null
      }))
    ],
    [
      'from "scope_roles"',
      [
        {
          user_id: 'admin',
          scope_type: 'season',
          scope_id: 's',
          role: 'admin'
        },
        { user_id: 'coach', scope_type: 'team', scope_id: 't', role: 'coach' }
      ].filter(row => userIds.includes(row.user_id))
    ],
    ['from "memberships"', []],
    ['permission_parents', [{ season_id: 's', team_id: 't' }]]
  ]
}

describe('inherited administrator capabilities', () => {
  it('notifies inherited and direct roster administrators once when a player rejects an add', async () => {
    const now = new Date('2027-03-01T00:00:00Z')
    const request: StoredRequest = {
      id: 'request',
      kind: 'playerAdd',
      sender_id: 'sender',
      sender_scope_type: 'team',
      sender_scope_id: 't',
      sender_hidden: false,
      supersedes_id: null,
      revision: 1,
      status: 'applied',
      sent_at: now,
      expires_at: new Date(now.getTime() + 86400000),
      resolved_at: null,
      resolved_by: null,
      game_id: null,
      initiating_team_id: 't',
      terms: {
        kind: 'playerAdd',
        mode: 'roster',
        userId: 'player',
        teamId: 't',
        teamName: 'Demo Team',
        jersey: null,
        positions: []
      }
    }
    let recipients: unknown
    await withQueryReplies(
      query => {
        const text = query.sql
        if (text.includes('with recursive up'))
          return (query.parameters[0] as string[]).map(id => ({
            start: id,
            survivor: id,
            id
          }))
        if (text.startsWith('insert into "notification_events"')) {
          expect(query.parameters).includes('playerAddRejected')
          recipients = query.parameters.find(
            value => Array.isArray(value) && value.includes('sender')
          )
          return []
        }
        if (
          /^(begin|commit|rollback|update|delete|insert)/.test(text) ||
          text.includes('pg_advisory_xact_lock') ||
          text.includes('pg_notify')
        )
          return []
        if (text.startsWith('select "value" from "system_settings"'))
          return [{ value: true }]
        if (text.includes('permission_parents'))
          return [{ id: 's', league_id: null }]
        if (text.includes('from "users"')) return [{ login_enabled: true }]
        if (
          text.includes('from "user_links"') ||
          text.includes('from "gumbo_ids"') ||
          text.includes('from "games"')
        )
          return []
        if (text.includes('from "teams"'))
          return [{ name: 'Demo Team', default_lineup: null }]
        if (text.includes('from "group_requests"'))
          return text.includes('select *')
            ? [{ ...request, status: 'declined' }]
            : []
        if (text.includes('from "memberships"'))
          return text.includes('inner join "users"') ? [{ id: 'owner' }] : []
        if (text.includes('from "scope_roles"')) {
          if (text.includes('"scope_id" = any('))
            return [{ user_id: 'inherited' }]
          if (text.includes('select "users"."id"')) return [{ id: 'direct' }]
          if (text.includes('select distinct "user_id"'))
            return [{ user_id: 'direct' }]
          return []
        }
        throw new Error(`Unexpected query: ${text}`)
      },
      async db => {
        const result = await atomic(
          db,
          async trx =>
            await decidePlayerAdd(
              trx,
              { userId: 'player', isAdmin: false, scopes: [] },
              request,
              'decline',
              { now: () => now }
            )
        )
        expect(result.status).equals('declined')
      }
    )
    expect(recipients).deep.equals(['sender', 'direct', 'owner', 'inherited'])
  })

  for (const hasTeam of [false, true]) {
    it(`finds player-add stand-ins through settled team authority (hasTeam=${hasTeam})`, async () => {
      const person: QueryStep = [
        'with recursive up',
        [{ start: 'player', survivor: 'player', id: 'player' }]
      ]
      await withQueryReplies(
        [
          person,
          person,
          ['from "user_links"', []],
          ['from "users"', [{ login_enabled: false }]],
          person,
          ['from "group_requests"', []],
          [
            'from "memberships"',
            hasTeam ? [{ team_id: 't' }] : [],
            query => {
              expect(query.parameters).includes('adding')
              expect(query.sql).includes('"is_player" =')
              expect(query.sql).includes('"team_id" not in')
            }
          ],
          ['from "scope_roles"', hasTeam ? [{ userId: 'coach' }] : []],
          ...(hasTeam
            ? ([
                ['from "scope_roles"', [{ id: 'coach' }]],
                ['from "memberships"', [{ id: 'owner' }]],
                ['system_settings', [{ value: true }]],
                ['permission_parents', [{ id: 's', league_id: null }]],
                ['from "teams"', [{ league_id: null }]],
                ['from "scope_roles"', [{ user_id: 'admin' }]]
              ] as QueryStep[])
            : [])
        ],
        async db => {
          expect(await playerAddApprovers(db, 'player', 'adding')).deep.equals({
            userIds: hasTeam ? ['admin', 'coach', 'owner'] : [],
            standIn: hasTeam,
            told: hasTeam ? 'coaches' : null
          })
        }
      )
    })
  }

  it('allows an inherited team administrator to manage exhibitions without granting unrelated teams', async () => {
    await withQueryReplies(
      [...replies(['admin']), ['system_settings', [{ value: true }]]],
      async db => {
        const rights = await scheduleRights(db, 'admin', false)
        expect(mayScheduleIn(rights, 't', null)).equals(true)
        // Inherited team administration reaches every season the team plays in.
        expect(mayScheduleIn(rights, 't', 'elsewhere')).equals(true)
        expect(mayScheduleIn(rights, 'other', null)).equals(false)
        expect(mayScheduleIn(rights, 'other', 's')).equals(true)
      }
    )
  })

  it('keeps scheduling rights to direct team administrators before the cutover', async () => {
    await withQueryReplies(
      [
        ...replies(['admin']),
        ['system_settings', []],
        ['from "scope_roles"', []],
        ['from "memberships"', []]
      ],
      async db => {
        const rights = await scheduleRights(db, 'admin', false)
        expect(mayScheduleIn(rights, 't', null)).equals(false)
        expect(mayScheduleIn(rights, 't', 's')).equals(true)
      }
    )
  })

  it('uses inherited admin and coach authority for the supplied chat members', async () => {
    await withQueryReplies(
      [
        ['permission_parents', [{ id: 's', league_id: 'l' }]],
        ['from "teams"', [{ league_id: null }]],
        [
          'from scope_roles',
          [{ userId: 'admin' }, { userId: 'closed' }, { userId: 'outsider' }],
          query => {
            expect(query.sql).includes("role in ('admin', 'coach')")
            expect(query.parameters).to.deep.include(['s'])
            expect(query.parameters).to.deep.include(['l'])
          }
        ],
        [
          'with recursive chain',
          [
            { startId: 'admin', survivorId: 'admin' },
            // A coach's grant left on an account merged into theirs.
            { startId: 'closed', survivorId: 'coach' },
            { startId: 'outsider', survivorId: 'outsider' }
          ]
        ],
        [
          'from "users"',
          [{ id: 'admin' }, { id: 'coach' }],
          query => {
            expect(query.sql).includes('"disabled_at" is null')
            expect(query.parameters).to.deep.include(['admin', 'coach'])
          }
        ]
      ],
      async db => {
        const moderators = await moderatorsOf(
          db,
          { kind: 'teamMembers', scope_id: 't' },
          ['admin', 'coach', 'member']
        )
        expect([...moderators]).deep.equals(['admin', 'coach'])
      }
    )
  })
})
