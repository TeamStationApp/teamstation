import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { findOAuthAccount } from '../oauth/provider'
import { peopleRoutes } from '../routes/people'

describe('account identity boundaries', function () {
  this.timeout(60000)
  let fixture: AccountHarness
  before(async () => {
    fixture = await accountHarness(undefined, (app, { db, media }) => {
      app.use('/api/v1', peopleRoutes(db, media))
    })
  })
  after(async () => {
    await fixture?.close()
  })

  it('accepts canonical person ids and refuses decimal or malformed API ids', async () => {
    const response = await fixture.request(
      'GET',
      `/players/${userIdOfGumbo(101)}`
    )
    expect(response.status).equals(200)
    expect((await response.json()).userId).equals(userIdOfGumbo(101))
    for (const id of [
      '101',
      '0',
      'usr_1111111111111111111111',
      'usr_zzzzzzzzzzzzzzzzzzzzzz',
      'usr_invalid'
    ]) {
      expect(
        (await fixture.request('GET', `/players/${id}`)).status,
        id
      ).equals(400)
    }
    expect(
      (await fixture.request('GET', '/teams/tem_account/people/101')).status
    ).equals(400)
  })

  it('resolves legacy OAuth grants to the same canonical subject without rewriting stored records', async () => {
    const legacy = await findOAuthAccount(fixture.db, '101')
    const canonical = await findOAuthAccount(fixture.db, userIdOfGumbo(101))
    expect(legacy?.accountId).equals(userIdOfGumbo(101))
    expect(await legacy?.claims('id_token', 'openid', {}, [])).deep.equals(
      await canonical?.claims('id_token', 'openid', {}, [])
    )
    expect((await legacy?.claims('id_token', 'openid', {}, []))?.sub).equals(
      userIdOfGumbo(101)
    )
    for (const id of [
      '99999',
      userIdOfGumbo(99999),
      '0',
      '01',
      '9007199254740992',
      'invalid'
    ]) {
      expect(await findOAuthAccount(fixture.db, id), id).equals(undefined)
    }
    await fixture.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', userIdOfGumbo(102))
      .execute()
    expect(await findOAuthAccount(fixture.db, '102')).equals(undefined)
    await fixture.db
      .updateTable('users')
      .set({ login_enabled: true, merged_into: userIdOfGumbo(101) })
      .where('id', '=', userIdOfGumbo(102))
      .execute()
    expect(await findOAuthAccount(fixture.db, '102')).equals(undefined)
  })
})
