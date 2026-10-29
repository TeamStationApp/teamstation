import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { type Session, TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import {
  type AccountHarness,
  accountHarness,
  accountTestPicture
} from '../../test/accountHarness'
import { createEmailCode } from '../auth/emailCodes'
import { hashToken, makeToken } from '../auth/tokens'
import { createInvite, revokeInvite } from '../invites/invites'
import { onboardingRoutes } from './onboarding'
import { pictureRoutes } from './pictures'

describe('signup and onboarding in the real HTTP service', function () {
  this.timeout(60000)
  let h: AccountHarness, client: TeamStationClient
  before(async () => {
    h = await accountHarness(undefined, (app, { db, media, space }) => {
      app.use('/api/v1', onboardingRoutes(db, media))
      app.use('/api/v1', pictureRoutes(db, space))
    })
    client = new TeamStationClient({ baseUrl: h.origin + '/api/v1' })
    client.analyticsApp = 'TS web'
  })
  after(async () => {
    await h?.close()
  })
  async function signup(email: string): Promise<Session> {
    await client.requestEmailCode(email)
    return await client.signInWithCode(email, h.mail.get(email)!)
  }
  it('sends an unknown address a code but creates the account only after verification', async () => {
    await client.requestEmailCode('plain@example.com')
    expect(h.mail.has('plain@example.com')).equals(true)
    expect(
      await h.db
        .selectFrom('user_emails')
        .selectAll()
        .where('email', '=', 'plain@example.com')
        .execute()
    ).length(0)
    const session = await client.signInWithCode(
      'plain@example.com',
      h.mail.get('plain@example.com')!
    )
    expect(session.user.onboarding?.step).equals('name')
    expect((await client.whoAmI())?.onboarding?.step).equals('name')
    expect(
      (
        await h.request(
          'POST',
          '/auth/email-code/verify',
          { email: 'plain@example.com', code: '000000' },
          null
        )
      ).status
    ).equals(401)
    expect(
      (
        await h.request(
          'POST',
          '/auth/email-code',
          { email: 'not-an-address' },
          null
        )
      ).status
    ).equals(400)
    expect((await client.onboarding()).displayName).equals('New account')
    const recorded = await sql<{
      user_id: string
      app: string
    }>`SELECT user_id, app FROM analytics.events WHERE event_name='account_created'`.execute(
      h.db
    )
    expect(recorded.rows).deep.equals([
      { user_id: session.user.id, app: 'TS web' }
    ])
  })
  it('enforces name before photo, saves it, resumes and completes with a reused picture', async () => {
    expect(
      (
        await h.request(
          'PUT',
          '/me/onboarding/photo',
          { initials: true },
          client.token
        )
      ).status
    ).equals(409)
    expect(
      (
        await h.request(
          'PUT',
          '/me/onboarding/name',
          { displayName: '' },
          client.token
        )
      ).status
    ).equals(400)
    const state = await client.saveOnboardingName('Mike Trout')
    expect(state.onboarding.step).equals('photo')
    const resumed = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: client.token
    })
    expect((await resumed.onboarding()).onboarding.step).equals('photo')
    expect(
      (await h.request('PUT', '/me/onboarding/photo', {}, client.token)).status
    ).equals(400)
    expect(
      (
        await h.request(
          'PUT',
          '/me/onboarding/photo',
          { catalogId: 'foreign' },
          client.token
        )
      ).status
    ).equals(400)
    await resumed.finishOnboarding({ catalogId: 'baseball' })
    expect((await resumed.whoAmI())?.onboarding?.step).equals('complete')
    expect((await resumed.onboarding()).onboarding.completedAt).not.equals(null)
    await resumed.finishOnboarding({ initials: true })
    expect(
      (
        await h.request(
          'PUT',
          '/me/onboarding/name',
          { displayName: 'Other' },
          client.token
        )
      ).status
    ).equals(409)
    expect(
      await h.db
        .selectFrom('memberships')
        .selectAll()
        .where('user_id', '=', (await resumed.whoAmI())!.id)
        .execute()
    ).length(0)
  })
  it('completes with initials or upload and leaves a failed upload resumable', async () => {
    await signup('initials@example.com')
    await client.saveOnboardingName('Ichiro')
    await client.finishOnboarding({ initials: true })
    expect((await client.whoAmI())?.avatarUrl).equals(null)
    await signup('upload@example.com')
    await client.saveOnboardingName('Mike Trout')
    h.controls.failPut = true
    expect(
      (
        await h.request(
          'PUT',
          '/me/onboarding/photo',
          { image: accountTestPicture },
          client.token
        )
      ).status
    ).equals(503)
    expect((await client.onboarding()).onboarding.step).equals('photo')
    h.controls.failPut = false
    await client.finishOnboarding({ image: accountTestPicture })
    expect((await client.whoAmI())?.onboarding?.step).equals('complete')
  })
  it('settles links and originating-client claims without duplication or suspension bypass', async () => {
    const wait = await client.requestEmailCode('link@example.com')
    const secret = new URL(h.links.get('link@example.com')!, h.origin).pathname
      .split('/')
      .at(-1)!
    const linked = await client.signInWithLink(secret)
    const originalClient = new TeamStationClient({
      baseUrl: h.origin + '/api/v1'
    })
    const claimed = await originalClient.claimSignIn(wait)
    expect(claimed?.user.id).equals(linked.user.id)
    expect((await originalClient.claimSignIn(wait))?.user.id).equals(
      linked.user.id
    )
    await h.db
      .updateTable('email_codes')
      .set({ expires_at: new Date(Date.now() - 1) })
      .where('id', '=', wait.requestId)
      .execute()
    expect(await originalClient.claimSignIn(wait)).equals(undefined)
    expect(
      await h.db
        .selectFrom('user_emails')
        .selectAll()
        .where('email', '=', 'link@example.com')
        .execute()
    ).length(1)
    expect(
      (await h.request('POST', '/auth/link/verify', { token: secret }, null))
        .status
    ).equals(401)
    const token = makeToken()
    await h.db
      .insertInto('api_tokens')
      .values({
        id: 'api_onboarding',
        user_id: userIdOfGumbo(101),
        label: 'Fixture',
        token_hash: hashToken(token)
      })
      .execute()
    expect(
      (await h.request('GET', '/me/onboarding', undefined, token)).status
    ).equals(401)
    expect(
      (
        await h.request(
          'PUT',
          '/me/onboarding/name',
          { displayName: 'Mike Trout' },
          token
        )
      ).status
    ).equals(401)
    expect(
      (
        await h.request(
          'PUT',
          '/me/onboarding/photo',
          { initials: true },
          token
        )
      ).status
    ).equals(401)
    await h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    expect((await h.request('GET', '/me/account')).status).equals(401)
    expect(
      (await h.request('GET', '/me/account', undefined, token)).status
    ).equals(401)
    await h.db
      .updateTable('users')
      .set({ disabled_at: null })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
  })
  it('verifies a plain account after its invitation is revoked, and fails mail delivery without an account', async () => {
    await h.db
      .updateTable('memberships')
      .set({ role: 'manager' })
      .where('user_id', '=', userIdOfGumbo(101))
      .execute()
    const invite = await createInvite(h.db, {
      scopeType: 'team',
      scopeId: 'tem_account',
      createdBy: userIdOfGumbo(101)
    })
    const claim = await createEmailCode(h.db, 'revoked@example.com', 'login', {
      inviteId: invite.id,
      displayName: 'Mike Trout'
    })
    await revokeInvite(h.db, invite.id)
    const response = await h.request(
      'POST',
      '/auth/email-code/verify',
      { email: 'revoked@example.com', code: claim.code },
      null
    )
    expect(response.status).equals(200)
    const body = (await response.json()) as Session
    expect(body.user.onboarding?.step).equals('name')
    // The account took the typed name; the spent code keeps none of it.
    expect(body.user.displayName).equals('Mike Trout')
    expect(
      (
        await h.db
          .selectFrom('email_codes')
          .select('display_name')
          .where('id', '=', claim.id)
          .executeTakeFirstOrThrow()
      ).display_name
    ).equals(null)
    expect(
      await h.db
        .selectFrom('memberships')
        .selectAll()
        .where('user_id', '=', body.user.id)
        .execute()
    ).length(0)
    h.controls.failMail = true
    expect(
      (
        await h.request(
          'POST',
          '/auth/email-code',
          { email: 'mail-failure@example.com' },
          null
        )
      ).status
    ).equals(503)
    h.controls.failMail = false
    expect(
      await h.db
        .selectFrom('user_emails')
        .selectAll()
        .where('email', '=', 'mail-failure@example.com')
        .execute()
    ).length(0)
  })
})
