import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { deliverAccountMail, setAccountMailEnabled } from './accountMail'

describe('account mail', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  it('stays off until a node administrator turns it on, and sign-in mail is not this switch', async () => {
    expect(
      (await f.h.request('GET', '/node/mail', undefined, null)).status
    ).equals(401)
    expect(
      (await f.h.request('GET', '/node/mail', undefined, 101)).status
    ).equals(403)
    expect(
      (await f.h.request('PUT', '/node/mail', { accountMessages: true }, 101))
        .status
    ).equals(403)

    const off = await f.h.request('GET', '/node/mail', undefined, 105)
    expect(off.status).equals(200)
    expect(await off.json()).deep.equals({ accountMessages: false })

    const skipped: string[] = []
    const logs: string[] = []
    await deliverAccountMail(
      f.h.db,
      'fan@example.com',
      async () => {
        skipped.push('sent')
      },
      { log: message => logs.push(message) }
    )
    expect(skipped).deep.equals([])
    expect(logs).deep.equals([
      'account mail is off; not sent to fan@example.com'
    ])

    const turnedOn = await f.h.request(
      'PUT',
      '/node/mail',
      { accountMessages: true },
      105
    )
    expect(turnedOn.status).equals(200)
    expect(await turnedOn.json()).deep.equals({ accountMessages: true })

    await deliverAccountMail(f.h.db, 'fan@example.com', async () => {
      skipped.push('sent')
    })
    expect(skipped).deep.equals(['sent'])

    await setAccountMailEnabled(f.h.db, actor(105), false)
    const again = await f.h.request('GET', '/node/mail', undefined, 105)
    expect(await again.json()).deep.equals({ accountMessages: false })
  })
})
