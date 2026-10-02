import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

/**
 * The sign-in link, read from the source.
 *
 * These rules are the ones that make the difference between a convenience and
 * a way to hand somebody's account to a robot, and each has a reason that is
 * easy to forget and expensive to rediscover. The database work they describe
 * needs a live Postgres, which this suite does not have, so what is asserted
 * here is that the decisions are still where they were put.
 */
describe('sign-in link', function () {
  const routes = readFileSync(join(__dirname, '../routes/auth.ts'), 'utf8')
  const codes = readFileSync(join(__dirname, 'emailCodes.ts'), 'utf8')
  const mail = readFileSync(join(__dirname, '../email/sendMail.ts'), 'utf8')
  const screen = readFileSync(
    join(__dirname, '../../app/screens/SignInLinkScreen.tsx'),
    'utf8'
  )
  // Where the "did this visitor ask for it" flag is kept. Two files, because
  // a browser and an app remember for different lengths of time and each has
  // to be the right length.
  const onceWeb = readFileSync(
    join(__dirname, '../../app/platform/onceStore.ts'),
    'utf8'
  )
  const onceNative = readFileSync(
    join(__dirname, '../../app/platform/onceStore.native.ts'),
    'utf8'
  )

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
    const link = routes.slice(routes.indexOf('function signInLink'))
    // Written out rather than interpolated: this is the shape of the line in
    // the source, not a link being built.
    expect(link).contains('/signin/')
    expect(link).contains('?r=')
    expect(routes).not.contains('teamstation://')
  })

  it('prints the address as text beside the button', function () {
    // Some clients eat buttons, and a sign-in that cannot be reached is worse
    // than an ugly one.
    expect(mail).contains('Or paste this address')
    expect(mail).contains('bgcolor="#334423"')
  })

  it('spends the token without a second tap only where a person asked', function () {
    expect(screen).contains('askedHere(requestId)')
    // For this visit and no longer, on either platform. A browser's session
    // storage lasts as long as the tab; an app's memory lasts as long as the
    // process. Anything more durable would spend a link somebody was sent
    // weeks ago the moment they opened it.
    expect(onceWeb).contains('sessionStorage')
    expect(onceNative).not.contains('AsyncStorage')
  })

  it('lets the machine that asked finish a sign-in done elsewhere', function () {
    expect(codes).contains('export async function claimApprovedRequest')
    expect(codes).contains('tokensMatch(row.client_secret_hash')
    expect(routes).contains("'/auth/request/claim'")
  })
})
