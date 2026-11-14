import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { Session } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { createInvite } from '../invites/invites'
import { inviteRoutes } from '../routes/invites'

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
