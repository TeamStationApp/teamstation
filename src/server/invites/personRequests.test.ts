import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { createSession } from '../auth/sessions'
import { hashToken } from '../auth/tokens'
import { rolesAt } from './people'

describe('personal group invitations and accepted role grants', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  async function invite(
    email = 'fixture106@example.com',
    key = 'personal-invite-first'
  ): Promise<{ requestId: string; code: string }> {
    const response = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      { email, admin: true, flags: ['scorekeeper'], idempotencyKey: key },
      101
    )
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
  it('keeps an existing account out of the group until the named recipient accepts the exact roles', async () => {
    const invitation = await invite()
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([])
    expect(
      await f.h.db
        .selectFrom('memberships')
        .selectAll()
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', 106)
        .execute()
    ).length(0)
    const inbox = (await (
      await f.h.request('GET', '/me/notifications', undefined, 106)
    ).json()) as {
      items: Array<{ requestId: string; description: string }>
      hasPending: boolean
    }
    expect(inbox.hasPending).equals(true)
    expect(inbox.items[0].requestId).equals(invitation.requestId)
    expect(inbox.items[0].description).includes('administrator')
    expect(await accept(invitation.requestId)).equals('accepted')
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([
      'admin',
      'scorekeeper'
    ])
    const pending = (await (
      await f.h.request('GET', `/manage/team/${f.teamA}`, undefined, 101)
    ).json()) as { pending: unknown[] }
    expect(pending.pending).length(0)
    expect(await accept(invitation.requestId)).equals('accepted')
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
    const inbox = (await (
      await f.h.request('GET', '/me/notifications', undefined, 201)
    ).json()) as { hasPending: boolean }
    expect(inbox.hasPending).equals(true)
    expect(await accept(invitation.requestId, 201)).equals('accepted')
    const request = await f.h.db
      .selectFrom('group_requests')
      .select('terms')
      .where('id', '=', invitation.requestId)
      .executeTakeFirstOrThrow()
    expect(request.terms).property('recipientUserId', 201)
    expect((await invite('new-person@example.com')).requestId).equals(
      invitation.requestId
    )
  })
  it('does not let another administrator or an email-forward recipient consume the named person side', async () => {
    const invitation = await invite()
    expect(await accept(invitation.requestId, 105)).equals('pending')
    const wrong = await f.h.request(
      'POST',
      `/join/${invitation.code}/redeem`,
      {},
      105
    )
    expect([403, 400]).includes(wrong.status)
    expect(await rolesAt(f.h.db, 'team', f.teamA, 106)).deep.equals([])
    expect(await accept(invitation.requestId)).equals('accepted')
  })
  it('expires at seven days, supports withdrawal/resend and closes declined email links', async () => {
    const original = await invite()
    f.advance(7 * 24 * 3600 * 1000)
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
      'fixture106@example.com',
      'personal-declined-one'
    )
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
  it('does not count a pending replacement administrator or permit an unconnected role endpoint to bypass acceptance', async () => {
    await invite()
    const bypass = await f.h.request(
      'PUT',
      `/manage/team/${f.teamA}/people/106/roles`,
      { admin: true, flags: [] },
      101
    )
    expect(bypass.status).equals(409)
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
      email: 'fixture106@example.com',
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
    const personal = await invite()
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
    const personal = await invite()
    const key = 'personal-address-retry'
    const sent = await f.h.request(
      'POST',
      `/relationship-requests/${personal.requestId}/resend`,
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
      `/relationship-requests/${personal.requestId}/resend`,
      { idempotencyKey: key },
      101
    )
    expect(repeated.status).equals(201)
    expect(await repeated.json()).property('id', next.id)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${personal.requestId}/resend`,
          { idempotencyKey: 'personal-new-wrong-address' },
          101
        )
      ).status
    ).equals(409)
    expect(await accept(next.id, 106)).equals('accepted')
  })
})
