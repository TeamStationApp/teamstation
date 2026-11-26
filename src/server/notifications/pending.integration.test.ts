import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import * as notices from '../../common/notifications'
import {
  CHAT_DEVICE_APPROVAL,
  LOCAL_COPY_EXPIRING,
  RECORDING_UPLOAD,
  UMPIRE_MISSING_SLOTS,
  UMPIRE_SIGN_UP,
  UMPIRE_WITHDRAW
} from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import type { Actor } from '../auth/sessions'
import { setScopeRoles } from '../invites/people'
import { hasPendingNotifications, inbox } from './inbox'
import { PLAYER_ADD_REJECTED } from './pending'

const PEOPLE = [101, 102, 103, 104, 105, 106]

describe('the bell answers what the inbox answers, without building it', function () {
  this.timeout(120000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const actorOf = (gumbo: number): Actor => ({
    userId: userIdOfGumbo(gumbo),
    isAdmin: gumbo === 105,
    scopes: []
  })
  /** Each person's bell, checked against the full inbox. */
  async function bells(): Promise<Record<number, boolean>> {
    const answers: Record<number, boolean> = {}
    for (const person of PEOPLE) {
      const actor = actorOf(person)
      const full = (await inbox(f.h.db, actor, {}, f.clock)).hasPending
      const cheap = await hasPendingNotifications(f.h.db, actor, f.clock)
      expect(cheap.hasPending, `person ${person}`).equals(full)
      answers[person] = cheap.hasPending
    }
    return answers
  }
  async function summary(person: number): Promise<unknown> {
    const response = await f.h.request(
      'GET',
      '/me/notifications/summary',
      undefined,
      person
    )
    expect(response.status).equals(200)
    return await response.json()
  }
  async function send(key: string): Promise<string> {
    const response = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        teamId: f.teamA,
        seasonId: f.seasonB,
        sender: { kind: 'season', id: f.seasonB },
        idempotencyKey: key
      },
      102
    )
    expect(response.status).equals(201)
    return ((await response.json()) as { id: string }).id
  }
  async function information(
    type: string,
    person: number,
    sourceId = randomUUID()
  ): Promise<string> {
    const id = randomUUID()
    await f.h.db
      .insertInto('notification_events')
      .values({
        id,
        source_type: type,
        source_id: sourceId,
        revision: 1,
        actor_id: null,
        metadata: JSON.stringify({
          title: 'A notice',
          userId: userIdOfGumbo(106)
        }),
        recorded_recipients: [userIdOfGumbo(person)],
        created_at: f.clock.now()
      })
      .execute()
    return id
  }
  async function dismiss(eventId: string, person: number): Promise<void> {
    await f.h.db
      .insertInto('notification_receipts')
      .values({
        event_id: eventId,
        user_id: userIdOfGumbo(person),
        viewed_at: f.clock.now(),
        dismissed_at: f.clock.now()
      })
      .execute()
  }

  it('is dark for everybody with nothing recorded, and the summary route says the same', async () => {
    expect(Object.values(await bells())).deep.equals(PEOPLE.map(() => false))
    expect(await summary(103)).deep.equals({ hasPending: false })
  })

  it('uses the request fallback without projecting resolved history or extending expiry', async () => {
    const id = await send('resolved-fallback')
    await f.h.db
      .updateTable('group_requests')
      .set({ status: 'accepted' })
      .where('id', '=', id)
      .execute()
    const queries: string[] = []
    const watched = f.h.db.withPlugin({
      transformQuery: args => {
        queries.push(JSON.stringify(args.node))
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    expect(
      await hasPendingNotifications(watched, actorOf(101), f.clock)
    ).deep.equals({ hasPending: false, nextExpiry: null })
    expect(
      queries.some(query => query.includes('"value":"' + id + '"')),
      'no per-request projection of resolved rows'
    ).equals(false)
    expect(await summary(101)).deep.equals({ hasPending: false })
    expect((await inbox(f.h.db, actorOf(101), {}, f.clock)).items).deep.equals(
      []
    )
  })

  it('lights for whoever may answer a request, through viewing, a role given and taken, acceptance and expiry', async () => {
    const id = await send('pending-bell')
    const sent = await bells()
    expect(sent[101], 'the team’s admin may answer').equals(true)
    expect(sent[104]).equals(false)
    expect(await summary(101)).deep.equals({ hasPending: true })
    // Viewing a request leaves it to answer.
    await f.h.request('PUT', `/me/notifications/${id}/viewed`, {}, 101)
    expect((await bells())[101]).equals(true)
    // A role given lets another answer; taken away, it does not.
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(104),
      { admin: true, flags: [] },
      userIdOfGumbo(101)
    )
    expect((await bells())[104]).equals(true)
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(104))
      .where('scope_id', '=', f.teamA)
      .execute()
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(104))
      .where('team_id', '=', f.teamA)
      .execute()
    expect((await bells())[104]).equals(false)
    // Its expiry is the bell's next change, and once past it the bell is
    // dark with nothing written.
    const answer = await hasPendingNotifications(f.h.db, actorOf(101), f.clock)
    expect(answer.nextExpiry).not.equals(null)
    f.advance(Date.parse(answer.nextExpiry!) - f.clock.now().getTime() + 1000)
    expect((await bells())[101]).equals(false)
  })

  it('lights for an accepted half that waits on the other side, and goes dark once both answer', async () => {
    const id = await send('two-sides')
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      101
    )
    expect(accepted.status).equals(200)
    await bells()
    await f.h.request('POST', `/relationship-requests/${id}/accept`, {}, 102)
    await bells()
  })

  it('lights for an upload reminder, a copy expiring, a rejected add and a missing-umpires digest until dismissed, and never for a grant or an umpire sign-up or withdrawal', async () => {
    const reminder = await information(RECORDING_UPLOAD, 103)
    const copy = await information(LOCAL_COPY_EXPIRING, 104)
    const rejected = await information(PLAYER_ADD_REJECTED, 106)
    const digest = await information(UMPIRE_MISSING_SLOTS, 101)
    await information('grant', 102)
    await information(UMPIRE_SIGN_UP, 102)
    await information(UMPIRE_WITHDRAW, 102)
    expect(await bells()).deep.include({
      101: true,
      102: false,
      103: true,
      104: true,
      106: true
    })
    // Somebody else's receipt dismisses nothing of theirs.
    await dismiss(reminder, 104)
    expect((await bells())[103]).equals(true)
    await dismiss(reminder, 103)
    await dismiss(copy, 104)
    await dismiss(rejected, 106)
    await dismiss(digest, 101)
    expect(await bells()).deep.include({
      101: false,
      103: false,
      104: false,
      106: false
    })
  })

  it('lights for a device asking to be approved until it is approved, declined, revoked or expired, and names its expiry', async () => {
    const owner = userIdOfGumbo(103)
    const device = async (name: string): Promise<string> => {
      const id = randomUUID()
      await f.h.db
        .insertInto('chat_devices')
        .values({
          id,
          user_id: owner,
          session_id: null,
          name,
          platform: 'ios',
          box_public_key: Buffer.alloc(32, 1),
          sign_public_key: Buffer.alloc(32, 2),
          revoked_at: null
        })
        .execute()
      return id
    }
    const link = async (hours: number): Promise<string> => {
      const id = randomUUID()
      await f.h.db
        .insertInto('chat_links')
        .values({
          id,
          user_id: owner,
          new_device_id: await device(id),
          approved_by_device_id: null,
          box: null,
          expires_at: new Date(f.clock.now().getTime() + hours * 3_600_000)
        })
        .execute()
      await information(CHAT_DEVICE_APPROVAL, 103, id)
      return id
    }
    const soon = await link(1)
    await link(5)
    expect((await bells())[103]).equals(true)
    const answer = await hasPendingNotifications(f.h.db, actorOf(103), f.clock)
    expect(answer.hasPending).equals(true)
    expect(Date.parse(answer.nextExpiry!)).equals(
      f.clock.now().getTime() + 3_600_000
    )
    await f.h.db
      .updateTable('chat_links')
      .set({ declined_at: f.clock.now() })
      .where('id', '=', soon)
      .execute()
    expect((await bells())[103]).equals(true)
    f.advance(6 * 3_600_000)
    expect((await bells())[103], 'both expired').equals(false)
  })

  it('shares one read among callers for the same person, and stops only once every caller has gone', async () => {
    await send('shared-read')
    const actor = actorOf(101)
    const gone = new AbortController()
    const leaving = hasPendingNotifications(f.h.db, actor, f.clock, gone.signal)
    const staying = hasPendingNotifications(f.h.db, actor, f.clock)
    // One caller goes while the other still waits: the read goes on.
    gone.abort()
    const [left, stayed] = await Promise.all([leaving, staying])
    expect(stayed.hasPending).equals(true)
    expect(left).equals(stayed)
    const alone = new AbortController()
    alone.abort()
    const stopped = await hasPendingNotifications(
      f.h.db,
      actor,
      f.clock,
      alone.signal
    )
    expect(stopped.hasPending, 'a walk nobody waits on ends').equals(false)
  })

  it('answers a caller who asks once a read has begun with a read of its own, which sees what committed since', async () => {
    const actor = actorOf(104)
    let first: Promise<unknown> | undefined
    let second: Promise<{ hasPending: boolean }> | undefined
    await f.h.db.transaction().execute(async trx => {
      // The read under way has its pending information, and waits on the
      // requests this transaction holds.
      await sql`lock table group_requests in access exclusive mode`.execute(trx)
      first = hasPendingNotifications(f.h.db, actor, f.clock)
      await new Promise(resolve => setTimeout(resolve, 300))
      // Meanwhile something waiting on the person commits.
      await f.h.db
        .insertInto('notification_events')
        .values({
          id: randomUUID(),
          source_type: PLAYER_ADD_REJECTED,
          source_id: randomUUID(),
          revision: 1,
          actor_id: null,
          metadata: JSON.stringify({
            title: 'A notice',
            userId: userIdOfGumbo(106)
          }),
          recorded_recipients: [userIdOfGumbo(104)],
          created_at: f.clock.now()
        })
        .execute()
      second = hasPendingNotifications(f.h.db, actor, f.clock)
    })
    const [, after] = await Promise.all([first!, second!])
    expect(after.hasPending, 'the caller who asked after it began').equals(true)
  })

  it('agrees for a notice of every kind the app knows, recorded for one person', async () => {
    const kinds = new Set(
      Object.entries(notices)
        .filter(
          ([name, value]) =>
            typeof value === 'string' && /^[A-Z][A-Z_]+$/.test(name)
        )
        .map(([, value]) => value as string)
    )
    kinds.add(PLAYER_ADD_REJECTED)
    kinds.add('grant')
    expect(kinds.size).greaterThan(4)
    for (const kind of kinds) {
      const id = await information(kind, 104)
      await bells()
      await f.h.db
        .deleteFrom('notification_events')
        .where('id', '=', id)
        .execute()
    }
  })
})
