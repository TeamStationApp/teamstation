import type { Kysely, Selectable } from 'kysely'

import type {
  GuardianTerms,
  Notification,
  PlayerAddTerms
} from '../../common/notifications'
import { guardiansOfEach, roleScopesForUsers } from '../access'
import { onePeople } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type {
  Database,
  GroupRequestSidesTable,
  NotificationEventsTable
} from '../db/database'
import { accountReadOnce, readOnce } from '../db/readOnce'
import {
  mayAnswerPlayerAdd,
  rejoinedSince,
  supersededPlayerAdd
} from '../groups/noticePolicy'
import {
  approvesSide,
  type Clock,
  requestStatus,
  speaksForSender,
  type StoredRequest
} from '../groups/requests'
import { canAdminister, canScheduleFor } from '../groups/rights'

export type RequestState = Omit<Notification, 'title' | 'description'> & {
  news: boolean
  senderOnly: boolean
}

type Side = Selectable<GroupRequestSidesTable>
type Event = Pick<
  Selectable<NotificationEventsTable>,
  'id' | 'source_id' | 'recorded_recipients'
>
interface Receipt {
  event_id: string
  dismissed_at: Date | null
}

/** Facts live for one read only. Windows batch the relational rows; wording is separate. */
export class InboxProjection {
  private waiting = false

  /** A positive live witness, including a candidate excluded only by the tab. */
  get hasPending(): boolean {
    return this.waiting
  }

  private readonly decisions = new Map<string, Promise<boolean>>()
  private readonly teams = new Set<string>()
  private readonly guardedPlayers = new Map<string, boolean>()
  constructor(
    readonly db: Kysely<Database>,
    readonly actor: Actor,
    readonly clock: Clock
  ) {}

  private async once(
    key: unknown[],
    read: () => Promise<boolean>
  ): Promise<boolean> {
    const name = JSON.stringify(key)
    let answer = this.decisions.get(name)
    if (answer == null) {
      answer = read()
      this.decisions.set(name, answer)
    }
    return await answer
  }

  /** Populate the existing transaction-local rights caches, including absent teams. */
  private async prepare(
    sides: Side[],
    requests: StoredRequest[]
  ): Promise<void> {
    let teamIds = [
      ...new Set([
        ...sides.filter(s => s.scope_type === 'team').map(s => s.scope_id),
        ...requests
          .filter(r => r.sender_scope_type === 'team')
          .map(r => r.sender_scope_id!)
      ])
    ].filter(id => !this.teams.has(id))
    while (teamIds.length > 0) {
      const found = await this.db
        .selectFrom('teams')
        .select(['id', 'kind', 'custodian_type', 'custodian_id', 'merged_into'])
        .where('id', 'in', teamIds)
        .execute()
      const byId = new Map(found.map(row => [row.id, row]))
      for (const id of teamIds) {
        this.teams.add(id)
        await readOnce(this.db, `teams:${id}:facts`, async () => byId.get(id))
      }
      teamIds = [
        ...new Set(
          found
            .filter(t => t.custodian_type === 'team' && t.custodian_id != null)
            .map(t => t.custodian_id!)
        )
      ].filter(id => !this.teams.has(id))
    }
    const players = [
      ...new Set(
        requests
          .filter(request => request.kind === 'guardian')
          .map(request => (request.terms as GuardianTerms).playerUserId)
      )
    ].filter(id => !this.guardedPlayers.has(id))
    if (players.length > 0) {
      const guardians = await guardiansOfEach(this.db, players, {
        signsIn: true
      })
      const guarded = new Set([...guardians.values()].flat())
      // guardiansOfEach already returns each player's current identity. Only
      // unresolved aliases need another merge walk; ordinary guarded players
      // must not repeat the same recursive query for every window.
      const unresolved = players.filter(id => !guarded.has(id))
      const people =
        unresolved.length === 0
          ? new Map()
          : await onePeople(this.db, unresolved)
      for (const id of players)
        this.guardedPlayers.set(
          id,
          guarded.has(id) || guarded.has(people.get(id)!.userId)
        )
    }
    const pendingIds = new Set(
      requests
        .filter(r => requestStatus(r, this.clock) === 'pending')
        .map(r => r.id)
    )
    const users = [
      ...new Set(
        sides
          .filter(s => pendingIds.has(s.request_id) && s.approved_by != null)
          .map(s => s.approved_by!)
      )
    ]
    if (users.length > 0) {
      const accounts = await this.db
        .selectFrom('users')
        .select([
          'id',
          'is_admin',
          'disabled_at',
          'merged_into',
          'login_enabled'
        ])
        .where('id', 'in', users)
        .execute()
      const byId = new Map(accounts.map(row => [row.id, row]))
      for (const id of users)
        await accountReadOnce(this.db, id, async () => byId.get(id))
      await roleScopesForUsers(this.db, users)
    }
  }

  async requests(
    requests: StoredRequest[]
  ): Promise<Map<string, RequestState | null>> {
    if (requests.length === 0) return new Map()
    const ids = requests.map(r => r.id)
    const sides = await this.db
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', 'in', ids)
      .execute()
    const events = await this.db
      .selectFrom('notification_events')
      .select(['id', 'source_id', 'recorded_recipients'])
      .where('source_type', '=', 'groupRequest')
      .where('source_id', 'in', ids)
      .execute()
    const receipts =
      events.length === 0
        ? []
        : await this.db
            .selectFrom('notification_receipts')
            .select(['event_id', 'dismissed_at'])
            .where('user_id', '=', this.actor.userId)
            .where(
              'event_id',
              'in',
              events.map(e => e.id)
            )
            .execute()
    await this.prepare(sides, requests)
    const byRequest = new Map<string, Side[]>()
    for (const side of sides)
      byRequest.set(side.request_id, [
        ...(byRequest.get(side.request_id) ?? []),
        side
      ])
    const bySource = new Map(events.map(e => [e.source_id, e]))
    const byEvent = new Map(receipts.map(r => [r.event_id, r]))
    const answer = new Map<string, RequestState | null>()
    for (const request of requests) {
      const event = bySource.get(request.id)
      const state = await this.request(
        request,
        byRequest.get(request.id) ?? [],
        event,
        event == null ? undefined : byEvent.get(event.id)
      )
      if (state != null && (state.canAct || state.news)) this.waiting = true
      answer.set(request.id, state)
    }
    return answer
  }

  private async approves(
    actor: Actor,
    side: Side,
    request: StoredRequest
  ): Promise<boolean> {
    // A team's guardian invitation loses its say once the player has a
    // guardian who can sign in. Batch that authoritative exclusion before
    // checking distinct requests; it never grants authority. Other guardian
    // sides and site administrators still use approvesSide unchanged.
    if (
      request.kind === 'guardian' &&
      side.scope_type === 'team' &&
      actor.userId === this.actor.userId &&
      !this.actor.isAdmin &&
      this.guardedPlayers.get((request.terms as GuardianTerms).playerUserId) ===
        true
    )
      return false
    const ref = { kind: side.scope_type, id: side.scope_id }
    // These rules depend on the player/game terms; keep the authoritative rule
    // and include every input in its memo key. Ordinary group sides depend only
    // on their live custodian and the reader's roles.
    const special = ['guardian', 'videographer', 'game', 'gameChange'].includes(
      request.kind
    )
    return await this.once(
      ['side', actor.userId, request.kind, ref, special ? request.terms : null],
      async () => {
        if (special || ref.kind === 'user')
          return await approvesSide(this.db, actor, ref, request)
        if (ref.kind === 'team') {
          const team = await readOnce(
            this.db,
            `teams:${ref.id}:facts`,
            async () =>
              undefined as
                | {
                    kind: string
                    custodian_type: 'team' | 'season' | 'league' | null
                    custodian_id: string | null
                  }
                | undefined
          )
          if (team?.kind === 'external') {
            if (team.custodian_type == null || team.custodian_id == null)
              return false
            return await canAdminister(this.db, actor, {
              kind: team.custodian_type,
              id: team.custodian_id
            })
          }
        }
        return await canAdminister(this.db, actor, {
          kind: ref.kind,
          id: ref.id
        })
      }
    )
  }

  private async request(
    request: StoredRequest,
    sides: Side[],
    event?: Event,
    receipt?: Receipt
  ): Promise<RequestState | null> {
    const { db, actor: fresh, clock } = this
    const status = requestStatus(request, clock)
    const historical =
      status !== 'pending' &&
      (request.sender_id === fresh.userId ||
        event?.recorded_recipients.includes(fresh.userId) === true ||
        receipt != null)
    const needsEligibility =
      status === 'pending' || !historical || request.kind === 'playerAdd'
    let eligible = false
    let actionable = false
    let representedConsent = false
    if (request.kind === 'playerAdd') {
      eligible = await this.once(
        ['playerAdd', request.sender_id, request.terms],
        async () => await mayAnswerPlayerAdd(db, fresh, request)
      )
      actionable = eligible
    }
    for (const side of request.kind === 'playerAdd' || !needsEligibility
      ? []
      : sides) {
      if (!(await this.approves(fresh, side, request))) continue
      eligible = true
      if (status !== 'pending') break
      const sideRef = { kind: side.scope_type, id: side.scope_id }
      if (
        side.scope_type === 'team' &&
        side.approved_by != null &&
        (request.kind === 'game' || request.kind === 'gameChange') &&
        (await this.once(
          ['schedule', sideRef],
          async () =>
            await canScheduleFor(db, fresh, { kind: 'team', id: side.scope_id })
        ))
      )
        representedConsent = true
      let valid = false
      if (side.approved_by != null) {
        try {
          valid = await this.approves(
            { userId: side.approved_by, isAdmin: false, scopes: [] },
            side,
            request
          )
        } catch {}
      }
      if (!valid) actionable = true
    }
    const senderAdmin = await this.once(
      [
        'sender',
        request.kind,
        request.sender_id,
        request.sender_scope_type,
        request.sender_scope_id
      ],
      async () => await speaksForSender(db, fresh, request)
    )
    const senderOnly =
      status === 'pending' &&
      !eligible &&
      !senderAdmin &&
      request.sender_id === fresh.userId
    if (!senderOnly && !eligible && !senderAdmin && !historical) return null
    const notice = request.kind === 'playerAdd' && status === 'applied'
    const canReject =
      notice &&
      eligible &&
      request.expires_at.getTime() > clock.now().getTime() &&
      !(await supersededPlayerAdd(db, request)) &&
      !(await rejoinedSince(db, request.terms as PlayerAddTerms))
    return {
      news: canReject && receipt?.dismissed_at == null,
      senderOnly,
      id: event?.id ?? request.id,
      requestId: request.id,
      type: request.kind,
      sentAt: request.sent_at.toISOString(),
      expiresAt: request.expires_at.toISOString(),
      status,
      canAct: !senderOnly && status === 'pending' && actionable,
      canWithdraw:
        status === 'pending' &&
        (senderAdmin ||
          request.sender_id === fresh.userId ||
          representedConsent),
      canResend:
        !senderOnly &&
        status !== 'accepted' &&
        senderAdmin &&
        !['guardian', 'membership', 'videographer', 'playerAdd'].includes(
          request.kind
        ),
      canReject,
      rejectUntil: notice ? request.expires_at.toISOString() : null,
      viewed: receipt != null,
      leave: null
    }
  }
}

export interface InformationFacts {
  receipts: Map<string, Receipt>
  links: Map<
    string,
    {
      box: unknown
      declined_at: Date | null
      expires_at: Date
      revoked_at: Date | null
    }
  >
}

/** Only selected information is enriched; its relational facts are read in sets. */
export async function informationFacts(
  db: Kysely<Database>,
  userId: string,
  events: Array<Selectable<NotificationEventsTable>>
): Promise<InformationFacts> {
  const receipts =
    events.length === 0
      ? []
      : await db
          .selectFrom('notification_receipts')
          .select(['event_id', 'dismissed_at'])
          .where('user_id', '=', userId)
          .where(
            'event_id',
            'in',
            events.map(e => e.id)
          )
          .execute()
  const linkIds = events
    .filter(e => e.source_type === 'chatDeviceApproval')
    .map(e => e.source_id)
  const links =
    linkIds.length === 0
      ? []
      : await db
          .selectFrom('chat_links')
          .innerJoin(
            'chat_devices',
            'chat_devices.id',
            'chat_links.new_device_id'
          )
          .select([
            'chat_links.id',
            'chat_links.box',
            'chat_links.declined_at',
            'chat_links.expires_at',
            'chat_devices.revoked_at'
          ])
          .where('chat_links.user_id', '=', userId)
          .where('chat_links.id', 'in', linkIds)
          .execute()
  return {
    receipts: new Map(receipts.map(r => [r.event_id, r])),
    links: new Map(links.map(l => [l.id, l]))
  }
}
