import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import * as access from '../access'
import type { StoredRequest } from '../groups/requests'
import * as rights from '../groups/rights'
import * as names from '../users/nameBook'
import {
  hasPendingNotifications,
  inbox,
  notificationDetail,
  notificationFor
} from './inbox'
import type { Candidate } from './inboxPage'
import * as pages from './inboxPage'
import type { RequestState } from './inboxProjection'
import * as projection from './inboxProjection'
import * as wording from './requestInformation'

const now = new Date('2027-01-01')
const actor = { userId: 'reader', isAdmin: true, scopes: [] }
const clock = { now: () => now }
const request: StoredRequest = {
  id: 'r',
  kind: 'membership',
  sender_id: 'sender',
  terms: {},
  sent_at: now,
  expires_at: now,
  status: 'pending',
  revision: 1,
  sender_hidden: false,
  sender_scope_type: null,
  sender_scope_id: null,
  resolved_at: null,
  resolved_by: null,
  game_id: null,
  initiating_team_id: null,
  supersedes_id: null
}
const state: RequestState = {
  id: 'r',
  requestId: 'r',
  type: 'membership',
  sentAt: now.toISOString(),
  expiresAt: now.toISOString(),
  status: 'pending',
  canAct: true,
  canWithdraw: false,
  canResend: false,
  canReject: false,
  rejectUntil: null,
  viewed: false,
  leave: null,
  news: false,
  senderOnly: false
}
const candidate = (extra: Partial<RequestState> = {}): Candidate => ({
  kind: 'request',
  rank: 1,
  sentAt: now.toISOString(),
  requestId: 'r',
  request,
  state: { ...state, ...extra }
})
async function* yieldRows(rows: Candidate[]): AsyncGenerator<Candidate> {
  yield* rows
}

describe('inbox orchestration keeps wording behind selection', () => {
  beforeEach(() => {
    mock.method(rights, 'currentActor', async () => actor)
    mock.method(access, 'adminScopes', async () => ({
      isAdmin: true,
      teamIds: new Set(),
      seasonIds: new Set(),
      leagueIds: new Set()
    }))
    mock.method(names, 'userNames', async () => new Map())
    mock.method(names, 'shortNamesOf', async () => new Map())
  })
  afterEach(() => {
    mock.restoreAll()
  })
  it('words only returned rows and carries a positive pending witness without another scan', async () => {
    mock.method(pages, 'requestPages', () =>
      yieldRows([candidate(), { ...candidate(), requestId: 's' }])
    )
    mock.method(pages, 'informationPages', () => yieldRows([]))
    const words = mock.method(wording, 'titleAndDescription', async () => ({
      title: 'Current title',
      description: 'Current text'
    }))
    await withQueryReplies([['teams', []]], async db => {
      const result = await inbox(db, actor, { limit: 1 }, clock)
      expect(result.items).length(1)
      expect(result.hasPending).equals(true)
      expect(result.nextCursor).equals(`1|${now.toISOString()}|r`)
      expect(words.mock.callCount()).equals(1)
    })
  })
  it('asks about all pending state on empty late pages, with no wording', async () => {
    mock.method(pages, 'requestPages', () => yieldRows([]))
    mock.method(pages, 'informationPages', () => yieldRows([]))
    await withQueryReplies(
      [
        ['teams', []],
        ['notification_events', [{ waiting: 1, expiry: now }]],
        ['group_requests', [{ expiry: null }]]
      ],
      async db => {
        expect(
          await inbox(
            db,
            actor,
            { history: true, cursor: '1|2999-01-01|z' },
            clock
          )
        ).deep.equals({ items: [], nextCursor: null, hasPending: true })
      }
    )
  })
  it('finds pending requests beyond Sent or an empty page and preserves expiry', async () => {
    let calls = 0
    mock.method(pages, 'requestPages', () =>
      yieldRows(++calls === 1 ? [] : [candidate()])
    )
    mock.method(pages, 'informationPages', () => yieldRows([]))
    await withQueryReplies(
      [
        ['teams', []],
        ['notification_events', [{ waiting: 0, expiry: null }]],
        ['group_requests', [{ expiry: now }]]
      ],
      async db => {
        expect(
          (await inbox(db, actor, { sent: true }, clock)).hasPending
        ).equals(true)
      }
    )
    mock.restoreAll()
    mock.method(rights, 'currentActor', async () => actor)
    mock.method(access, 'adminScopes', async () => ({
      isAdmin: true,
      teamIds: new Set(),
      seasonIds: new Set(),
      leagueIds: new Set()
    }))
    mock.method(pages, 'requestPages', () => yieldRows([]))
    await withQueryReplies(
      [
        ['teams', []],
        ['notification_events', [{ waiting: 0, expiry: null }]],
        ['group_requests', [{ expiry: null }]]
      ],
      async db => {
        expect(await hasPendingNotifications(db, actor, clock)).deep.equals({
          hasPending: false,
          nextExpiry: null
        })
      }
    )
  })
  it('uses batched information facts for a chat source ID and never words an inaccessible link', async () => {
    const event = {
      id: 'event',
      source_id: 'link',
      source_type: 'chatDeviceApproval',
      revision: 1,
      actor_id: null,
      recorded_recipients: ['reader'],
      created_at: now,
      metadata: { title: 'Device' }
    }
    mock.method(pages, 'requestPages', () => yieldRows([]))
    mock.method(pages, 'informationPages', () =>
      yieldRows([
        {
          kind: 'information',
          rank: 1,
          sentAt: now.toISOString(),
          requestId: 'link',
          event
        }
      ])
    )
    mock.method(projection, 'informationFacts', async () => ({
      receipts: new Map([['event', { event_id: 'event', dismissed_at: null }]]),
      links: new Map([
        [
          'link',
          { box: 'box', declined_at: null, expires_at: now, revoked_at: null }
        ]
      ])
    }))
    await withQueryReplies(
      [
        ['teams', []],
        ['notification_events', [{ waiting: 0, expiry: null }]],
        ['group_requests', [{ expiry: null }]]
      ],
      async db => {
        const result = await inbox(db, actor, { history: true }, clock)
        expect(result.items[0]).include({
          requestId: 'link',
          status: 'accepted',
          viewed: true
        })
      }
    )
  })
  it('shares state with detail projection, including sender-only text and existing read transactions', async () => {
    mock.method(wording, 'titleAndDescription', async () => ({
      title: 'Named',
      description: 'Current'
    }))
    let selected: RequestState | null = state
    mock.method(
      projection.InboxProjection.prototype,
      'requests',
      async () => new Map([['r', selected]])
    )
    await withQueryReplies([], async db => {
      expect((await notificationFor(db, actor, request, clock))?.title).equals(
        'Named'
      )
      selected = {
        ...state,
        senderOnly: true,
        canAct: false,
        canWithdraw: true
      }
      await db
        .transaction()
        .execute(async trx =>
          expect(
            (await notificationFor(trx, actor, request, clock))?.title
          ).equals('Pending invitation you sent')
        )
      selected = null
      expect(await notificationFor(db, actor, request, clock)).equals(null)
    })
  })
  it('keeps standalone chat detail on the same live receipt/link facts', async () => {
    const event = {
      id: 'event',
      source_id: 'link',
      source_type: 'chatDeviceApproval',
      revision: 1,
      actor_id: null,
      recorded_recipients: ['reader'],
      created_at: now,
      metadata: { title: 'Device' }
    }
    await withQueryReplies(
      [
        ['group_requests', []],
        ['notification_events', [event]],
        ['notification_receipts', [{ event_id: 'event', dismissed_at: null }]],
        [
          'chat_links',
          [{ box: null, declined_at: now, revoked_at: null, expires_at: now }]
        ]
      ],
      async db => {
        expect(await notificationDetail(db, actor, 'event', clock)).include({
          requestId: 'link',
          status: 'declined',
          viewed: true
        })
      }
    )
  })
})
