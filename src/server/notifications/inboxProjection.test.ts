import { mock } from 'node:test'

import { expect } from 'chai'
import type { Selectable } from 'kysely'
import { afterEach, describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import * as access from '../access'
import * as people from '../admin/people'
import type { GroupRequestSidesTable } from '../db/database'
import { withRolesRead } from '../db/readOnce'
import * as policy from '../groups/noticePolicy'
import type { StoredRequest } from '../groups/requests'
import * as requests from '../groups/requests'
import * as rights from '../groups/rights'
import * as openAdds from '../openAdds'
import {
  InboxProjection,
  informationFacts,
  type RequestState
} from './inboxProjection'

const now = new Date('2027-01-01')
const actor = { userId: 'reader', isAdmin: false, scopes: [] }
const request = (extra: Partial<StoredRequest> = {}): StoredRequest => ({
  id: 'r',
  revision: 1,
  sender_hidden: false,
  kind: 'participation',
  sender_id: 'sender',
  sender_scope_type: 'season',
  sender_scope_id: 'sending',
  terms: {},
  status: 'pending',
  sent_at: now,
  expires_at: new Date(now.getTime() + 1000),
  resolved_at: null,
  resolved_by: null,
  game_id: null,
  initiating_team_id: null,
  supersedes_id: null,
  ...extra
})
const side = (
  extra: Partial<Selectable<GroupRequestSidesTable>> = {}
): Selectable<GroupRequestSidesTable> => ({
  request_id: 'r',
  scope_type: 'team',
  scope_id: 'receiving',
  approved_by: null,
  approved_at: null,
  ...extra
})

describe('notification state classification without wording', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  async function classify(
    row: StoredRequest,
    options: {
      sides?: Array<ReturnType<typeof side>>
      recorded?: boolean
      receipt?: boolean
      dismissed?: boolean
      eligible?: boolean
      sender?: boolean
      approvalValid?: boolean
      external?: 'missing' | 'league' | 'team'
      player?: boolean
      superseded?: boolean
      rejoined?: boolean
      guarded?: boolean
      mergedPlayer?: boolean
      siteAdmin?: boolean
      guardianId?: string
      identities?: Record<string, { userId: string; userIds: string[] }>
      playerSignsIn?: boolean
      standInTeam?: boolean
    } = {}
  ): Promise<{
    state: RequestState | null | undefined
    eligible: number
    sender: number
    playerChecks: number
  }> {
    const eligible = mock.method(
      requests,
      'approvesSide',
      async (...[_db, who]: Parameters<typeof requests.approvesSide>) => {
        if (who.userId === 'broken') throw Error('closed account')
        return who.userId === actor.userId
          ? (options.eligible ?? true)
          : (options.approvalValid ?? false)
      }
    )
    mock.method(
      rights,
      'canAdminister',
      async (...[_db, _who, ref]: Parameters<typeof rights.canAdminister>) =>
        options.eligible ?? ref.id === 'receiving'
    )
    mock.method(rights, 'canScheduleFor', async () => true)
    mock.method(access, 'hierarchyReady', async () => true)
    mock.method(
      openAdds,
      'openAddsOf',
      async () => new Map([['other-team', new Set()]])
    )
    const sender = mock.method(
      requests,
      'speaksForSender',
      async () => options.sender ?? false
    )
    mock.method(
      access,
      'roleScopesForUsers',
      async () =>
        new Map([
          [
            actor.userId,
            {
              admin: { teamIds: new Set(['other-team']) },
              coach: { teamIds: new Set() },
              assistant: { teamIds: new Set() }
            }
          ]
        ])
    )
    mock.method(
      people,
      'onePeople',
      async (...[_db, ids]: Parameters<typeof people.onePeople>) =>
        new Map(
          ids.map(id => [
            id,
            options.identities?.[id] ?? {
              userId: options.mergedPlayer === true ? 'survivor' : id,
              userIds: [id]
            }
          ])
        )
    )
    mock.method(
      access,
      'guardiansOfEach',
      async (...[_db, ids]: Parameters<typeof access.guardiansOfEach>) =>
        options.guarded === true
          ? new Map([
              [
                options.guardianId ?? 'guardian',
                options.mergedPlayer === true ? ['survivor'] : [...ids]
              ]
            ])
          : new Map()
    )
    const playerChecks = mock.method(
      policy,
      'mayAnswerPlayerAdd',
      async () => options.player ?? true
    )
    const sides = options.sides ?? [side()]
    const event = {
      id: 'event',
      source_id: row.id,
      recorded_recipients: options.recorded === true ? [actor.userId] : []
    }
    let result: Awaited<ReturnType<InboxProjection['requests']>> = new Map()
    await withQueryReplies(
      q => {
        if (q.sql.includes('with candidates as'))
          return options.superseded === true || options.rejoined === true
            ? [{ id: row.id }]
            : []
        if (q.sql.includes('from "user_emails"')) return []
        if (q.sql.includes('from "group_request_sides"')) return sides
        if (q.sql.includes('from "notification_events"'))
          return options.recorded === true || options.receipt === true
            ? [event]
            : []
        if (q.sql.includes('from "notification_receipts"'))
          return options.receipt === true
            ? [
                {
                  event_id: event.id,
                  dismissed_at: options.dismissed === true ? now : null
                }
              ]
            : []
        if (q.sql.includes('from "scope_roles"'))
          return [{ scope_id: 'other-team' }]
        if (q.sql.includes('from "memberships"'))
          return options.standInTeam === false
            ? []
            : [{ user_id: 'player', team_id: 'other-team' }]
        if (q.sql.includes('from "users"'))
          return [
            {
              id: row.kind === 'playerAdd' ? 'player' : 'approver',
              is_admin: false,
              disabled_at: null,
              merged_into: null,
              login_enabled: options.playerSignsIn ?? false
            }
          ]
        if (q.sql.includes('from "teams"'))
          return [
            {
              id: 'receiving',
              kind: options.external != null ? 'external' : 'full',
              custodian_type:
                options.external === 'missing'
                  ? null
                  : (options.external ?? null),
              custodian_id:
                options.external === 'team' ? 'custodian' : 'receiving',
              merged_into: null
            }
          ]
        throw Error('Unexpected state query ' + q.sql)
      },
      async db => {
        await withRolesRead(db, async () => {
          const projection = new InboxProjection(
            db,
            { ...actor, isAdmin: options.siteAdmin === true },
            { now: () => now }
          )
          expect(await projection.requests([])).deep.equals(new Map())
          result = await projection.requests([row])
          expect(projection.hasPending).equals(
            [...result.values()].some(
              state => state != null && (state.canAct || state.news)
            )
          )
        })
      }
    )
    return {
      state: result.get(row.id),
      eligible: eligible.mock.callCount(),
      sender: sender.mock.callCount(),
      playerChecks: playerChecks.mock.callCount()
    }
  }
  it('permits live sides and does not call the wording functions', async () => {
    const { state } = await classify(request())
    expect(state).include({
      canAct: true,
      canWithdraw: false,
      canResend: false,
      news: false,
      senderOnly: false
    })
    expect(state).not.have.property('title')
  })
  it('preserves the original sender withdrawal after role loss, while outsiders see nothing', async () => {
    expect(
      (await classify(request({ sender_id: 'reader' }), { eligible: false }))
        .state
    ).include({ senderOnly: true, canWithdraw: true, canAct: false })
    mock.restoreAll()
    expect((await classify(request(), { eligible: false })).state).equals(null)
  })
  it('retains resolved recipient/receipt access without validating old approvals', async () => {
    for (const recorded of [true, false]) {
      mock.restoreAll()
      const result = await classify(request({ status: 'accepted' }), {
        eligible: false,
        recorded,
        receipt: !recorded,
        sides: [side({ approved_by: 'approver' })]
      })
      expect(result.state).include({
        status: 'accepted',
        canAct: false,
        canWithdraw: false,
        viewed: !recorded
      })
    }
    mock.restoreAll()
    expect(
      (
        await classify(request({ status: 'cancelled', sender_id: 'reader' }), {
          eligible: false
        })
      ).state?.status
    ).equals('cancelled')
  })
  it('honors live approved-side validity and represented scheduling withdrawal', async () => {
    for (const approvalValid of [false, true]) {
      mock.restoreAll()
      const result = await classify(request({ kind: 'gameChange' }), {
        approvalValid,
        sides: [side({ approved_by: 'approver' })]
      })
      expect(result.state).include({
        canAct: !approvalValid,
        canWithdraw: true
      })
    }
    mock.restoreAll()
    expect(
      (
        await classify(request({ kind: 'game' }), {
          sides: [side({ approved_by: 'broken' })]
        })
      ).state?.canAct
    ).equals(true)
  })
  it('keeps guardian/user rules authoritative, including external team custody', async () => {
    expect(
      (
        await classify(request({ kind: 'guardian' }), {
          sides: [
            side({ scope_type: 'user', scope_id: 'email:reader@example.test' })
          ]
        })
      ).eligible
    ).equals(1)
    for (const external of ['missing', 'league', 'team'] as const) {
      mock.restoreAll()
      expect(
        (await classify(request(), { external, eligible: true })).state == null
      ).equals(external === 'missing')
    }
  })
  it('keeps rejected adds in Pending only until dismissal, supersession, rejoin or exact expiry', async () => {
    for (const options of [
      {},
      { dismissed: true, receipt: true },
      { superseded: true },
      { rejoined: true }
    ]) {
      mock.restoreAll()
      const result = await classify(
        request({
          kind: 'playerAdd',
          terms: { userId: 'player' },
          status: 'applied'
        }),
        options
      )
      const reject = options.superseded !== true && options.rejoined !== true
      expect(result.state).include({
        canReject: reject,
        news: reject && options.dismissed !== true,
        rejectUntil: new Date(now.getTime() + 1000).toISOString()
      })
    }
    mock.restoreAll()
    expect(
      (
        await classify(
          request({
            kind: 'playerAdd',
            terms: { userId: 'player' },
            status: 'applied',
            expires_at: now
          })
        )
      ).state?.canReject
    ).equals(false)
    mock.restoreAll()
    expect(
      (await classify(request({ expires_at: now }), { sender: true })).state
    ).include({ status: 'expired', canResend: true, canAct: false })
  })
  it('uses batched player-add identities for guardian precedence, self and sender exclusion', async () => {
    const row = request({
      kind: 'playerAdd',
      terms: { userId: 'player', teamId: 'adding' }
    })
    for (const options of [
      { guarded: true, guardianId: 'reader' },
      { guarded: true, guardianId: 'someone-else' },
      {
        guarded: true,
        guardianId: 'reader',
        identities: {
          sender: { userId: 'reader', userIds: ['sender', 'reader'] }
        }
      },
      { playerSignsIn: true },
      {
        identities: {
          sender: { userId: 'reader', userIds: ['sender', 'reader'] }
        }
      },
      { standInTeam: false }
    ]) {
      mock.restoreAll()
      const answer = await classify(row, options)
      expect(answer.state?.canAct ?? false).equals(
        options.guardianId === 'reader' && options.identities == null
      )
      expect(answer.playerChecks).equals(0)
    }
    mock.restoreAll()
    const self = await classify(
      request({ ...row, terms: { userId: 'old-player', teamId: 'adding' } }),
      {
        playerSignsIn: true,
        identities: {
          'old-player': {
            userId: 'player',
            userIds: ['player', 'old-player', 'reader']
          }
        }
      }
    )
    expect(self.state?.canAct).equals(true)
  })
  it('batch-denies guarded player team sides without granting or denying other guardian sides', async () => {
    const row = request({
      kind: 'guardian',
      terms: {
        kind: 'guardian',
        playerUserId: 'player',
        guardian: { userId: 'parent' }
      }
    })
    const denied = await classify(row, { guarded: true })
    expect(denied.state).equals(null)
    expect(denied.eligible).equals(0)
    mock.restoreAll()
    const merged = await classify(row, { guarded: true, mergedPlayer: true })
    expect(merged.state).equals(null)
    expect(merged.eligible).equals(0)
    mock.restoreAll()
    const admin = await classify(row, { guarded: true, siteAdmin: true })
    expect(admin.state?.canAct).equals(true)
    expect(admin.eligible).equals(1)
    mock.restoreAll()
    const person = await classify(row, {
      guarded: true,
      sides: [side({ scope_type: 'user', scope_id: 'player' })]
    })
    expect(person.eligible).equals(0)
    expect(person.state).equals(null)
    mock.restoreAll()
    const guardian = await classify(row, {
      guarded: true,
      guardianId: actor.userId,
      sides: [side({ scope_type: 'user', scope_id: 'player' })]
    })
    expect(guardian.eligible).equals(1)
  })
  it('never grants resend for special one-shot request kinds', async () => {
    for (const kind of [
      'guardian',
      'membership',
      'videographer',
      'playerAdd'
    ] as const) {
      mock.restoreAll()
      expect(
        (
          await classify(request({ kind, status: 'declined' }), {
            sender: true
          })
        ).state?.canResend
      ).equals(false)
    }
  })
  it('reuses only matching known identities in the authoritative guardian batch', async () => {
    const identity = { userId: 'player', userIds: ['player', 'old-player'] }
    const calls: string[][] = []
    mock.method(
      people,
      'onePeople',
      async (...[_db, ids]: Parameters<typeof people.onePeople>) => {
        calls.push([...ids])
        return new Map(
          ids.map(id => [
            id,
            id === 'guardian' ? { userId: id, userIds: [id] } : identity
          ])
        )
      }
    )
    for (const known of [
      new Map([
        ['old-player', identity],
        ['guardian', { userId: 'guardian', userIds: ['guardian'] }]
      ]),
      new Map([['old-player', { userId: 'other', userIds: ['other'] }]])
    ]) {
      await withQueryReplies(
        q => {
          if (q.sql.includes('from "user_links"'))
            return [{ user_id: 'guardian', related_user_id: 'old-player' }]
          if (q.sql.includes('from "users"')) return [{ id: 'guardian' }]
          throw Error(q.sql)
        },
        async db => {
          expect(
            await access.guardiansOfEach(
              db,
              ['old-player'],
              { signsIn: true },
              known
            )
          ).deep.equals(new Map([['guardian', ['player']]]))
        }
      )
    }
    expect(calls).deep.equals([[], [], ['old-player'], ['guardian']])
  })
  it('reads information receipts and device facts in sets, including empty sets', async () => {
    await withQueryReplies([], async db => {
      expect(await informationFacts(db, 'reader', [])).deep.equals({
        receipts: new Map(),
        links: new Map()
      })
    })
    await withQueryReplies(
      [
        ['notification_receipts', [{ event_id: 'e', dismissed_at: now }]],
        [
          'chat_links',
          [
            {
              id: 'link',
              box: null,
              declined_at: now,
              expires_at: now,
              revoked_at: null
            }
          ]
        ]
      ],
      async db => {
        const result = await informationFacts(db, 'reader', [
          { id: 'e', source_id: 'link', source_type: 'chatDeviceApproval' }
        ] as never)
        expect(result.receipts.get('e')?.dismissed_at).equals(now)
        expect(result.links.get('link')?.declined_at).equals(now)
      }
    )
    await withQueryReplies([['notification_receipts', []]], async db => {
      expect(
        (
          await informationFacts(db, 'reader', [
            { id: 'e', source_type: 'grant' }
          ] as never)
        ).links.size
      ).equals(0)
    })
  })
})
