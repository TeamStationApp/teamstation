import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { scratchDatabase } from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import {
  claimApprovedRequest,
  claimSignInLink,
  createEmailCode,
  forgetTypedName,
  verifyEmailCode
} from './emailCodes'

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

/**
 * The name typed at sign-up lives on a code only while it is pending: issuing
 * the next code forgets it on the codes it spends and on every expired one,
 * and a sign-in forgets it once its account is settled.
 */
describe('a sign-in code’s typed name', function () {
  this.timeout(60000)

  let db: Kysely<Database> | undefined
  let drop: (() => Promise<void>) | undefined

  before(async function () {
    ;({ db, drop } = await scratchDatabase('emailcodenames'))
  })

  after(async function () {
    await drop?.()
  })

  const row = async (
    id: string
  ): Promise<{ display_name: string | null; consumed_at: Date | null }> =>
    await db!
      .selectFrom('email_codes')
      .select(['display_name', 'consumed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  it('is forgotten on the code a newer one supersedes, and kept on the newer', async function () {
    if (db == null) this.skip()
    const first = await createEmailCode(db, 'trout@example.com', 'login', {
      displayName: 'Mike Trout'
    })
    expect((await row(first.id)).display_name).equals('Mike Trout')
    const second = await createEmailCode(db, ' Trout@Example.com ', 'login', {
      displayName: 'Mike Trout'
    })
    expect(await row(first.id)).deep.include({ display_name: null })
    expect((await row(first.id)).consumed_at).not.equals(null)
    expect(await row(second.id)).deep.equals({
      display_name: 'Mike Trout',
      consumed_at: null
    })
  })

  it('is read by the spend and forgotten once the sign-in is settled', async function () {
    if (db == null) this.skip()
    const typed = await createEmailCode(db, 'ohtani@example.com', 'login', {
      displayName: 'Shohei Ohtani'
    })
    const claim = await verifyEmailCode(
      db,
      'ohtani@example.com',
      'login',
      typed.code
    )
    expect(claim).deep.equals({
      codeId: typed.id,
      inviteId: null,
      displayName: 'Shohei Ohtani'
    })
    await forgetTypedName(db, typed.id)
    expect((await row(typed.id)).display_name).equals(null)

    const linked = await createEmailCode(db, 'judge@example.com', 'login', {
      displayName: 'Aaron Judge'
    })
    const byLink = await claimSignInLink(db, linked.token)
    expect(byLink?.codeId).equals(linked.id)
    expect(byLink?.displayName).equals('Aaron Judge')
    // The client that asked still reads it, until the sign-in forgets it.
    const approved = await claimApprovedRequest(
      db,
      linked.id,
      linked.clientSecret
    )
    expect(approved?.codeId).equals(linked.id)
    expect(approved?.displayName).equals('Aaron Judge')
    await forgetTypedName(db, linked.id)
    expect((await row(linked.id)).display_name).equals(null)
  })

  it('is forgotten on an expired code by the next code issued for anybody, and kept on a pending one', async function () {
    if (db == null) this.skip()
    const late = await createEmailCode(db, 'betts@example.com', 'login', {
      displayName: 'Mookie Betts'
    })
    const waiting = await createEmailCode(db, 'soto@example.com', 'login', {
      displayName: 'Juan Soto'
    })
    await db
      .updateTable('email_codes')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', late.id)
      .execute()
    expect((await row(late.id)).display_name).equals('Mookie Betts')

    await createEmailCode(db, 'harper@example.com', 'login')
    // Another address's expired code forgets the name and is not spent;
    // a pending one is left alone.
    expect(await row(late.id)).deep.equals({
      display_name: null,
      consumed_at: null
    })
    expect(await row(waiting.id)).deep.equals({
      display_name: 'Juan Soto',
      consumed_at: null
    })
  })

  it('finds both kinds of code it updates by index', async function () {
    if (db == null) this.skip()
    // A scratch table is small enough that a sequential scan wins; forbid it
    // to see which indexes the issuing update's two halves can use.
    const plan = await db.transaction().execute(async trx => {
      await sql`set local enable_seqscan = off`.execute(trx)
      const { rows } = await sql<{ 'QUERY PLAN': string }>`
        explain (costs off)
        update email_codes set display_name = null
          where (lower(email) = 'harper@example.com' and purpose = 'login'
                 and consumed_at is null)
             or (expires_at <= now() and display_name is not null)`.execute(trx)
      return rows.map(line => line['QUERY PLAN']).join('\n')
    })
    expect(plan).contains('email_codes_email')
    expect(plan).contains('email_codes_named_expiry')
  })
})
