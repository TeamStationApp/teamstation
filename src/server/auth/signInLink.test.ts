import { expect } from 'chai'
import { readFileSync } from 'fs'
import { after, before, describe, it } from 'mocha'
import { join } from 'path'

import type { Session } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { createInvite } from '../invites/invites'
import { inviteRoutes } from '../routes/invites'
import { signInLink } from './emailCodes'

/**
 * The sign-in link, read from the source.
 *
 * These rules are the ones that make the difference between a convenience and
 * a way to hand somebody's account to a robot, and each has a reason that is
 * easy to forget and expensive to rediscover. What is asserted here is that
 * the decisions are still where they were put; spending a sign-in once, and
 * only once when two claims race, is tested against Postgres in
 * emailCodes.test.ts.
 */
describe('sign-in link', function () {
  const routes = readFileSync(join(__dirname, '../routes/auth.ts'), 'utf8')
  const codes = readFileSync(join(__dirname, 'emailCodes.ts'), 'utf8')
  const invites = readFileSync(join(__dirname, '../routes/invites.ts'), 'utf8')
  const mail = readFileSync(join(__dirname, '../email/sendMail.ts'), 'utf8')

  it('never spends the link on a GET', function () {
    // Mail scanners follow links before anybody reads them. A `GET` that
    // signed somebody in would hand the session to whichever robot read the
    // mailbox first, and at best burn the link before the person taps it.
    expect(routes).contains("router.post(\n    '/auth/link/verify'")
    expect(routes).not.contains("router.get(\n    '/auth/link")
  })

  it('stores a hash of the link, never the link', function () {
    expect(codes).contains('token_hash: hashEmailCode(token)')
    expect(codes).not.match(/token_hash: token\b/)
  })

  it('makes the link and the code one sign-in', function () {
    // Both live on the same row, so whichever arrives first consumes it and
    // there is no window in which a used link still works.
    expect(codes).contains('token_hash: hashEmailCode(token)')
    expect(codes).contains('code_hash: hashEmailCode(code)')
    const claim = codes.slice(
      codes.indexOf('export async function claimSignInLink')
    )
    expect(claim).contains('consumed_at: now')
  })

  it('records where the sign-in started, rather than guessing later', function () {
    // The phone app does not exist yet. Recording this now is what stops every
    // link having to be reissued the day it does.
    expect(codes).contains("origin: options.origin ?? 'web'")
    expect(routes).contains('origin: body.origin')
  })

  it('mails an https address on our own domain, never a scheme of our own', function () {
    expect(signInLink('https://app.teamstation.app/', 'tok123')).equals(
      'https://app.teamstation.app/signin/tok123'
    )
    // Read where the links are built, and where they are mailed from.
    expect(codes).not.contains('teamstation://')
    expect(routes).not.contains('teamstation://')
    expect(invites).not.contains('teamstation://')
  })

  it('sends a sign-in asked for in an app to that app’s own host', function () {
    // The app's operating system opens only the host it verified, so the link
    // goes there, and names the server that issued it: the app spends it
    // against its own server, and the host sends a browser to this one.
    expect(
      signInLink('https://gs.example/', 'tok123', 'https://app1.example.test')
    ).equals(
      'https://app1.example.test/signin/tok123?server=https%3A%2F%2Fgs.example'
    )
    expect(routes).contains(
      'signInLink(options.publicUrl, request.token, appOrigin)'
    )
    expect(invites).contains(
      'signInLink(options.publicUrl, request.token, appOrigin)'
    )
    // Checked before anything is counted or looked up.
    const ask = routes.slice(routes.indexOf("'/auth/email-code',"))
    expect(ask.indexOf('allowedAppOrigin(')).lessThan(
      ask.indexOf('checkLimits(')
    )
  })

  it('prints the address as text beside the button', function () {
    // Some clients eat buttons, and a sign-in that cannot be reached is worse
    // than an ugly one.
    expect(mail).contains('Or paste this address')
    expect(mail).contains('bgcolor="#334423"')
  })

  it('lets the machine that asked finish a sign-in done elsewhere', function () {
    expect(codes).contains('export async function claimApprovedRequest')
    expect(codes).contains('tokensMatch(row.client_secret_hash')
    expect(routes).contains("'/auth/request/claim'")
  })

  it('forgets the typed name only once the account is settled', function () {
    // Every door — the code, the link, the approved request — comes through
    // `userForSignIn`, which reads the name from the claim before clearing it.
    const settle = routes.slice(routes.indexOf('const userForSignIn'))
    expect(settle.indexOf('forgetTypedName(db, claim.codeId)')).greaterThan(
      settle.indexOf('await settleAccount(db, email)')
    )
  })
})

/**
 * Joining through an invite link with a typed name, through the real routers
 * against a real database: the account takes the name, and the code that
 * carried it keeps none once the account exists.
 */
describe('joining through an invite link with a typed name', function () {
  this.timeout(60000)
  let h: AccountHarness

  before(async () => {
    h = await accountHarness(undefined, (app, { db, sendCode }) => {
      app.use(
        '/api/v1',
        inviteRoutes(db, { sendCode, publicUrl: 'http://localhost' })
      )
    })
  })
  after(async () => {
    await h?.close()
  })

  it('makes the account with the typed name, and then the code holds none', async () => {
    const invite = await createInvite(h.db, {
      scopeType: 'team',
      scopeId: 'tem_account',
      createdBy: userIdOfGumbo(101)
    })
    const asked = await h.request(
      'POST',
      `/join/${invite.code}/email-code`,
      { email: 'mays@example.com', displayName: 'Willie Mays' },
      null
    )
    expect(asked.status).equals(202)
    const { requestId } = (await asked.json()) as { requestId: string }
    const typedName = async (): Promise<string | null> =>
      (
        await h.db
          .selectFrom('email_codes')
          .select('display_name')
          .where('id', '=', requestId)
          .executeTakeFirstOrThrow()
      ).display_name
    expect(await typedName()).equals('Willie Mays')

    const token = new URL(h.links.get('mays@example.com')!).pathname
      .split('/')
      .at(-1)!
    const spent = await h.request('POST', '/auth/link/verify', { token }, null)
    expect(spent.status).equals(200)
    const session = (await spent.json()) as Session
    expect(session.user.displayName).equals('Willie Mays')
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', session.user.id)
          .executeTakeFirstOrThrow()
      ).display_name
    ).equals('Willie Mays')
    expect(await typedName()).equals(null)
  })
})
