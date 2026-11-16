import { expect } from 'chai'
import { describe, it } from 'mocha'

import { DEVELOP_APP_ORIGIN, SERVER_KEY } from '../native/serverOverride'
import { developServerControl as webControl } from './serverControl'
import { developServerControl } from './serverControl.native'

describe('the develop server control', function () {
  it('is a develop phone build’s alone, and keeps the server it is given', async function () {
    expect(webControl()).equals(undefined)
    expect(developServerControl('https://app.teamstation.app')).equals(
      undefined
    )
    const store = new Map<string, string>()
    const control = developServerControl(DEVELOP_APP_ORIGIN, {
      getItem: async key => store.get(key) ?? null,
      setItem: async (key, value) => {
        store.set(key, value)
      }
    })
    expect(await control?.('e2e-03.teamstation.app')).equals(
      'e2e-03.teamstation.app'
    )
    expect(store.get(SERVER_KEY)).equals('https://e2e-03.teamstation.app')
  })
})
