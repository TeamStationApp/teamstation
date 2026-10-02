import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { scratchDatabase } from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { claimSignInLink, createEmailCode, verifyEmailCode } from './emailCodes'

/**
 * The link and the code in one e-mail are one sign-in, spent once. The page
 * the link opens spends it the moment it runs, so two tabs, or a person and
 * a scanner, can reach the row together; only one of them may win.
 */
describe('spending a sign-in', function () {
  this.timeout(60000)

  let db: Kysely<Database> | undefined
  let drop: (() => Promise<void>) | undefined

  before(async function () {
    ;({ db, drop } = await scratchDatabase('emailcodes'))
  })

  after(async function () {
    await drop?.()
  })

  it('spends a link once', async function () {
    if (db == null) this.skip()
    const request = await createEmailCode(db, 'once@example.com', 'login')
    const first = await claimSignInLink(db, request.token)
    expect(first?.email).equals('once@example.com')
    expect(await claimSignInLink(db, request.token)).equals(null)
  })

  it('lets one of two claims racing for a link win, and only one', async function () {
    if (db == null) this.skip()
    const request = await createEmailCode(db, 'race@example.com', 'login')
    const claims = await Promise.all(
      Array.from(
        { length: 8 },
        async () => await claimSignInLink(db!, request.token)
      )
    )
    expect(claims.filter(claim => claim != null)).has.lengthOf(1)
  })

  it('refuses the link once the code has been typed', async function () {
    if (db == null) this.skip()
    const request = await createEmailCode(db, 'code-first@example.com', 'login')
    const typed = await verifyEmailCode(
      db,
      'code-first@example.com',
      'login',
      request.code
    )
    expect(typed).not.equals(null)
    expect(await claimSignInLink(db, request.token)).equals(null)
  })

  it('refuses the code once the link has been followed', async function () {
    if (db == null) this.skip()
    const request = await createEmailCode(db, 'link-first@example.com', 'login')
    expect(await claimSignInLink(db, request.token)).not.equals(null)
    expect(
      await verifyEmailCode(db, 'link-first@example.com', 'login', request.code)
    ).equals(null)
  })

  it('lets one of a link and its code racing win, and only one', async function () {
    if (db == null) this.skip()
    const request = await createEmailCode(db, 'both@example.com', 'login')
    const [byLink, byCode] = await Promise.all([
      claimSignInLink(db, request.token),
      verifyEmailCode(db, 'both@example.com', 'login', request.code)
    ])
    expect([byLink, byCode].filter(won => won != null)).has.lengthOf(1)
  })

  it('counts every wrong guess sent together', async function () {
    if (db == null) this.skip()
    const request = await createEmailCode(db, 'guesses@example.com', 'login')
    const wrong = request.code === '000000' ? '111111' : '000000'
    await Promise.all(
      Array.from(
        { length: 5 },
        async () =>
          await verifyEmailCode(db!, 'guesses@example.com', 'login', wrong)
      )
    )
    // Five wrong, however they arrived, and the code is dead.
    expect(
      await verifyEmailCode(db, 'guesses@example.com', 'login', request.code)
    ).equals(null)
  })

  it('refuses a link that has run out', async function () {
    if (db == null) this.skip()
    const request = await createEmailCode(db, 'late@example.com', 'login')
    await db
      .updateTable('email_codes')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', request.id)
      .execute()
    expect(await claimSignInLink(db, request.token)).equals(null)
  })
})
