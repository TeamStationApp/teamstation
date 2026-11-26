import { mock } from 'node:test'

import { expect } from 'chai'
import type { Selectable } from 'kysely'
import { afterEach, describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import * as access from '../access'
import type { GroupRequestSidesTable } from '../db/database'
import { withRolesRead } from '../db/readOnce'
import * as policy from '../groups/noticePolicy'
import type { StoredRequest } from '../groups/requests'
import * as requests from '../groups/requests'
import * as rights from '../groups/rights'
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
    } = {}
  ): Promise<{
    state: RequestState | null | undefined
    eligible: number
    sender: number
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
    const sender = mock.method(
      requests,
      'speaksForSender',
      async () => options.sender ?? false
    )
    mock.method(access, 'roleScopesForUsers', async () => new Map())
    mock.method(
      policy,
      'mayAnswerPlayerAdd',
      async () => options.player ?? true
    )
    mock.method(
      policy,
      'supersededPlayerAdd',
      async () => options.superseded ?? false
    )
    mock.method(policy, 'rejoinedSince', async () => options.rejoined ?? false)
    const sides = options.sides ?? [side()]
    const event = {
      id: 'event',
      source_id: row.id,
      recorded_recipients: options.recorded === true ? [actor.userId] : []
    }
    let result: Awaited<ReturnType<InboxProjection['requests']>> = new Map()
    await withQueryReplies(
      q => {
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
        if (q.sql.includes('from "users"'))
          return [
            {
              id: 'approver',
              is_admin: false,
              disabled_at: null,
              merged_into: null,
              login_enabled: true
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
          const projection = new InboxProjection(db, actor, { now: () => now })
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
      sender: sender.mock.callCount()
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
        request({ kind: 'playerAdd', status: 'applied' }),
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
          request({ kind: 'playerAdd', status: 'applied', expires_at: now })
        )
      ).state?.canReject
    ).equals(false)
    mock.restoreAll()
    expect(
      (await classify(request({ expires_at: now }), { sender: true })).state
    ).include({ status: 'expired', canResend: true, canAct: false })
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
