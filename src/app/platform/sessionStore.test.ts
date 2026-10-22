import { expect } from 'chai'

import { userIdOfGumbo } from '../../common/userId'
import { loadToken, loadUser, saveToken, saveUser } from './sessionStore'
import { asStoredUser, sessionUserOf, storedUserOf } from './storedUser'

describe('the web session store', function () {
  it('keeps no token and no user: the cookie is the session', async function () {
    await saveToken('token-one')
    expect(await loadToken()).equals(undefined)
    await saveUser({
      id: userIdOfGumbo(7),
      displayName: 'Ichiro S',
      isAdmin: true
    })
    expect(await loadUser()).equals(undefined)
    await saveUser(undefined)
    await saveToken(undefined)
  })

  it('keeps id, display name and isAdmin of a session user, and restores them', function () {
    const kept = storedUserOf(
      sessionUserOf({
        id: userIdOfGumbo(7),
        displayName: 'Ichiro S',
        isAdmin: true
      })
    )
    expect(kept).deep.equals({
      id: userIdOfGumbo(7),
      displayName: 'Ichiro S',
      isAdmin: true
    })
    expect(asStoredUser(JSON.parse(JSON.stringify(kept)))).deep.equals(kept)
    expect(() =>
      asStoredUser({ id: 'nobody', displayName: 'x', isAdmin: false })
    ).throws()
  })
})
