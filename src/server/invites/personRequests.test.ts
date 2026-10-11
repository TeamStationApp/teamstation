import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { createSession } from '../auth/sessions'
import { hashToken } from '../auth/tokens'
import { rolesAt } from './people'
import { invitePerson } from './personRequests'

/**
 * Adding somebody to a group by address.
 *
 * An address an account has verified is added at once, with no acceptance,
 * and told; an address nobody holds yet waits as an invitation, applied when
 * somebody signs up with it or verifies it, or accepted from its link.
 */
describe('personal group invitations and accepted role grants', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  async function add(
    email: string,
    key = 'personal-invite-first',
    body: Record<string, unknown> = { admin: true, flags: ['scorekeeper'] }
  ): Promise<Response> {
    return await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      { email, ...body, idempotencyKey: key },
      101
    )
  }
  async function invite(
    email = 'newcomer@example.com',
    key = 'personal-invite-first'
  ): Promise<{ requestId: string; code: string }> {
    const response = await add(email, key)
    expect(response.status, await response.clone().text()).equals(201)
    return (
      (await response.json()) as {
        invited: { requestId: string; code: string }
      }
    ).invited
  }
  async function accept(id: string, user = 106): Promise<string> {
    const response = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      user
    )
    expect(response.status, await response.clone().text()).equals(200)
    return ((await response.json()) as { status: string }).status
  }
  /** Gives a fixture account another address, verified. */
  async function verify(userId: number, email: string): Promise<void> {
    await f.h.db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: userId,
        email,
        verified_at: new Date(),
        is_primary: false
      })
      .execute()
  }
  interface Inbox {
    items: Array<{
      id: string
      type: string
      title: string
      requestId: string
      description: string
      viewed: boolean
      leave?: { kind: string; id: string; name: string } | null
    }>
    hasPending: boolean
  }
  const inbox = async (user: number, history = false): Promise<Inbox> =>
    (await (
      await f.h.request(
        'GET',
        `/me/notifications${history ? '?history=1' : ''}`,
        undefined,
        user
      )
    ).json()) as Inbox

  it('adds an existing account at once with the roles asked for, tells them, and offers to leave', async () => {
    const response = await add('FIXTURE106@example.com')
    expect(response.status, await response.clone().text()).equals(201)
    expect(await response.json()).deep.equals({
      added: true,
      person: {
        userId: 106,
        displayName: 'Tim Raines',
        email: 'fixture106@example.com'
      }
    })
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([
      'admin',
      'scorekeeper'
    ])
    expect(
      await f.h.db
        .selectFrom('memberships')
        .select('role')
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', 106)
        .execute()
    ).deep.equals([{ role: 'member' }])
    expect(
      await f.h.db.selectFrom('group_requests').select('id').execute()
    ).length(0)

    // The inbox says who did it and as what, and lights the bell until read.
    const before = await inbox(106)
    expect(before.hasPending).equals(true)
    const notice = before.items.find(item => item.type === 'grant')!
    expect(notice.title).equals(
      'Babe Ruth added you as Admin and Scorekeeper of Demo Hawks'
    )
    expect(notice.leave).deep.equals({
      kind: 'team',
      id: f.teamA,
      name: 'Demo Hawks'
    })
    // And the mail says the same, linking to it.
    expect(f.h.invitations.get('fixture106@example.com')).deep.equals({
      addedBy: 'Babe Ruth',
      scopeName: 'Demo Hawks',
      roles: 'Admin and Scorekeeper',
      link: `/notifications/${notice.id}`
    })
    expect(
      (
        await f.h.request(
          'PUT',
          `/me/notifications/${notice.id}/viewed`,
          {},
          106
        )
      ).status
    ).equals(200)
    const after = await inbox(106)
    expect(after.hasPending).equals(false)
    expect(after.items.some(item => item.type === 'grant')).equals(false)
    expect((await inbox(106, true)).items.map(item => item.id)).includes(
      notice.id
    )

    // Leaving takes the membership and every role here; the notification
    // stops offering it.
    expect(
      await (
        await f.h.request(
          'DELETE',
          `/me/groups/team/${f.teamA}`,
          undefined,
          106
        )
      ).json()
    ).deep.equals({ removed: true })
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([])
    const detail = (await (
      await f.h.request('GET', `/me/notifications/${notice.id}`, undefined, 106)
    ).json()) as Inbox['items'][number]
    expect(detail.leave).equals(null)

    // The administrator who added them is not told about their own act.
    expect(
      (await inbox(101)).items.filter(item => item.type === 'grant')
    ).deep.equals([])
  })

  it('leaves nothing done when the mail for an existing account fails, and adds it on the retry', async () => {
    f.h.controls.failMail = true
    expect(
      (await add('fixture106@example.com', 'personal-fail-1')).status
    ).equals(500)
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([])
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'grant')
        .execute()
    ).length(0)
    f.h.controls.failMail = false
    const retried = await add('fixture106@example.com', 'personal-fail-1')
    expect(((await retried.json()) as { added: boolean }).added).equals(true)
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([
      'admin',
      'scorekeeper'
    ])
  })

  it('does not create an account for an unknown address and binds its verified recipient identity on acceptance', async () => {
    const invitation = await invite('new-person@example.com')
    expect(
      await f.h.db
        .selectFrom('user_emails')
        .selectAll()
        .where('email', '=', 'new-person@example.com')
        .execute()
    ).length(0)
    await f.h.db
      .insertInto('users')
      .values({
        id: 201,
        legacyId: 'usr_new_recipient',
        display_name: 'Hank Aaron',
        login_enabled: true
      })
      .execute()
    await f.h.db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: 201,
        email: 'new-person@example.com',
        verified_at: new Date(),
        is_primary: true
      })
      .execute()
    f.h.tokens.set(201, (await createSession(f.h.db, 201, 'fixture')).token)
    expect((await inbox(201)).hasPending).equals(true)
    expect(await accept(invitation.requestId, 201)).equals('accepted')
    const request = await f.h.db
      .selectFrom('group_requests')
      .select('terms')
      .where('id', '=', invitation.requestId)
      .executeTakeFirstOrThrow()
    expect(request.terms).property('recipientUserId', 201)
    expect(await rolesAt(f.h.db, 'team', f.teamA, 201)).deep.equals([
      'admin',
      'scorekeeper'
    ])
    // Accepting is told like any other grant, in the sender's name.
    expect(
      (await inbox(201)).items.find(item => item.type === 'grant')?.title
    ).equals('Babe Ruth added you as Admin and Scorekeeper of Demo Hawks')
    // The address is theirs now: adding it again finds nothing new to give.
    const again = await add('new-person@example.com')
    expect(((await again.json()) as { added: boolean }).added).equals(false)
  })

  it('applies an invitation to an address when somebody signs up with it, and when an account verifies it', async () => {
    const signUp = await invite('signs-up@example.com', 'personal-sign-up')
    const second = await invite('second@example.com', 'personal-second')
    // The fixture's clock is not the server's: keep the invitations open.
    await f.h.db
      .updateTable('group_requests')
      .set({ expires_at: new Date(Date.now() + 24 * 3600 * 1000) })
      .execute()

    // A new account, made by signing in with a code sent to the address.
    expect(
      (
        await f.h.request(
          'POST',
          '/auth/email-code',
          { email: 'signs-up@example.com' },
          null
        )
      ).status
    ).equals(202)
    const session = await f.h.request(
      'POST',
      '/auth/email-code/verify',
      {
        email: 'signs-up@example.com',
        code: f.h.mail.get('signs-up@example.com')
      },
      null
    )
    expect(session.status).equals(200)
    const made = await f.h.db
      .selectFrom('user_emails')
      .select('user_id')
      .where('email', '=', 'signs-up@example.com')
      .executeTakeFirstOrThrow()
    expect(await rolesAt(f.h.db, 'team', f.teamA, made.user_id)).deep.equals([
      'admin',
      'scorekeeper'
    ])
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', signUp.requestId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('accepted')

    // An existing account adding the address to itself.
    const asked = await f.h.request(
      'POST',
      '/me/account/emails/request',
      { email: 'second@example.com' },
      104
    )
    expect(asked.status).equals(202)
    const confirmed = await f.h.request(
      'POST',
      '/me/account/emails/confirm',
      {
        ...((await asked.json()) as { requestId: string }),
        code: f.h.mail.get('second@example.com')
      },
      104
    )
    expect(confirmed.status, await confirmed.clone().text()).equals(200)
    expect(await rolesAt(f.h.db, 'team', f.teamA, 104)).deep.equals([
      'admin',
      'scorekeeper'
    ])
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select(['status', 'terms'])
          .where('id', '=', second.requestId)
          .executeTakeFirstOrThrow()
      ).terms
    ).property('recipientUserId', 104)
    expect(
      (await inbox(104)).items.find(item => item.type === 'grant')?.title
    ).equals('Babe Ruth added you as Admin and Scorekeeper of Demo Hawks')
  })

  it('does not let another administrator or an email-forward recipient consume the named person side', async () => {
    const invitation = await invite('forward@example.com')
    expect(await accept(invitation.requestId, 105)).equals('pending')
    const wrong = await f.h.request(
      'POST',
      `/join/${invitation.code}/redeem`,
      {},
      105
    )
    expect([403, 400]).includes(wrong.status)
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([])
    await verify(106, 'forward@example.com')
    expect(await accept(invitation.requestId)).equals('accepted')
  })

  it('expires at seven days, supports withdrawal/resend and closes declined email links', async () => {
    const original = await invite('later@example.com')
    f.advance(7 * 24 * 3600 * 1000)
    await verify(106, 'later@example.com')
    expect(await accept(original.requestId)).equals('expired')
    const resend = await f.h.request(
      'POST',
      `/relationship-requests/${original.requestId}/resend`,
      { idempotencyKey: 'personal-resend-first' },
      101
    )
    expect(resend.status, await resend.clone().text()).equals(201)
    const next = (await resend.json()) as { id: string }
    expect(next.id).not.equals(original.requestId)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${next.id}/withdraw`,
          {},
          101
        )
      ).status
    ).equals(200)
    const declined = await invite(
      'declines@example.com',
      'personal-declined-one'
    )
    await verify(106, 'declines@example.com')
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${declined.requestId}/decline`,
          {},
          106
        )
      ).status
    ).equals(200)
    expect(
      (
        await f.h.db
          .selectFrom('invites')
          .select('revoked_at')
          .where('request_id', '=', declined.requestId)
          .executeTakeFirstOrThrow()
      ).revoked_at
    ).not.equals(null)
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([])
  })

  it('does not count a pending replacement administrator, and gives nobody off the list a role by id', async () => {
    await invite('replacement@example.com')
    const bypass = await f.h.request(
      'PUT',
      `/manage/team/${f.teamA}/people/106/roles`,
      { admin: true, flags: [] },
      101
    )
    expect(bypass.status).equals(404)
    const remove = await f.h.request(
      'DELETE',
      `/manage/team/${f.teamA}/people/101`,
      undefined,
      101
    )
    expect(remove.status).equals(409)
  })

  it('retries failed invitation delivery with the same request and link and rejects bad roles, addresses and retry keys', async () => {
    f.h.controls.failMail = true
    const body = {
      email: 'retry@example.com',
      admin: true,
      idempotencyKey: 'personal-mail-retry'
    }
    expect(
      (await f.h.request('POST', `/manage/team/${f.teamA}/people`, body, 101))
        .status
    ).equals(500)
    f.h.controls.failMail = false
    const first = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      body,
      101
    )
    const second = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      body,
      101
    )
    expect(await first.json()).deep.equals(await second.json())
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'person')
        .execute()
    ).length(1)
    for (const changed of [
      { ...body, email: 'bad' },
      { ...body, flags: ['invalid'] },
      { ...body, idempotencyKey: 'short' }
    ])
      expect(
        (
          await f.h.request(
            'POST',
            `/manage/team/${f.teamA}/people`,
            changed,
            101
          )
        ).status
      ).equals(400)
  })

  it('offers requested roles to an existing member and restores a consumed link only for its accepted recipient', async () => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamA,
        user_id: 106,
        role: 'member'
      })
      .execute()
    const personal = await invite('member-later@example.com')
    await verify(106, 'member-later@example.com')
    const before = (await (
      await f.h.request('GET', `/join/${personal.code}`, undefined, 106)
    ).json()) as { alreadyIn: boolean; requestedRoles: string[] }
    expect(before.alreadyIn).equals(false)
    expect(before.requestedRoles).includes('administrator')
    const machine = 'fixture-personal-machine-token'
    await f.h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: 106,
        label: 'fixture',
        token_hash: hashToken(machine),
        scopes: []
      })
      .execute()
    expect(
      (await f.h.request('POST', `/join/${personal.code}/redeem`, {}, machine))
        .status
    ).equals(403)
    expect(
      (await f.h.request('POST', `/join/${personal.code}/redeem`, {}, 106))
        .status
    ).equals(200)
    const after = (await (
      await f.h.request('GET', `/join/${personal.code}`, undefined, 106)
    ).json()) as { valid: boolean; alreadyIn: boolean }
    expect(after).includes({ valid: true, alreadyIn: true })
    const outsider = (await (
      await f.h.request('GET', `/join/${personal.code}`, undefined, 104)
    ).json()) as { valid: boolean }
    expect(outsider.valid).equals(false)
  })

  it('keeps a known recipient bound when an email changes hands and does not resend to the new holder', async () => {
    // An invitation made out to an account, as they were before accounts
    // were added at once: it is still answered, and resent, the old way.
    const { request } = await invitePerson(
      f.h.db,
      actor(101),
      { kind: 'team', id: f.teamA },
      {
        email: 'fixture106@example.com',
        admin: true,
        flags: ['scorekeeper'],
        idempotencyKey: 'personal-known-recipient'
      },
      f.clock
    )
    const key = 'personal-address-retry'
    const sent = await f.h.request(
      'POST',
      `/relationship-requests/${request.id}/resend`,
      { idempotencyKey: key },
      101
    )
    const next = (await sent.json()) as { id: string }
    await f.h.db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: 106,
        email: 'current-recipient@example.com',
        verified_at: new Date()
      })
      .execute()
    await f.h.db
      .updateTable('user_emails')
      .set({ user_id: 104, is_primary: false })
      .where('email', '=', 'fixture106@example.com')
      .execute()
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${next.id}/accept`,
          {},
          104
        )
      ).status
    ).equals(403)
    const repeated = await f.h.request(
      'POST',
      `/relationship-requests/${request.id}/resend`,
      { idempotencyKey: key },
      101
    )
    expect(repeated.status).equals(201)
    expect(await repeated.json()).property('id', next.id)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${request.id}/resend`,
          { idempotencyKey: 'personal-new-wrong-address' },
          101
        )
      ).status
    ).equals(409)
    expect(await accept(next.id, 106)).equals('accepted')
  })

  it('adds an account at once through a person relationship request too', async () => {
    const sent = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'person',
        sender: { kind: 'team', id: f.teamA },
        recipientEmail: 'fixture104@example.com',
        admin: false,
        flags: ['coach'],
        idempotencyKey: 'personal-relationship-account'
      },
      101
    )
    expect(sent.status, await sent.clone().text()).equals(201)
    expect(await sent.json()).property('status', 'accepted')
    expect(await rolesAt(f.h.db, 'team', f.teamA, 104)).deep.equals(['coach'])
    const again = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'person',
        sender: { kind: 'team', id: f.teamA },
        recipientEmail: 'fixture104@example.com',
        admin: false,
        flags: ['coach'],
        idempotencyKey: 'personal-relationship-again'
      },
      101
    )
    expect(again.status).equals(409)
  })
})
