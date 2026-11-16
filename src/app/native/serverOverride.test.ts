import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  apiBaseFor,
  DEVELOP_APP_ORIGIN,
  isDevelopBuild,
  loadServerOverride,
  saveServerOverride,
  SERVER_KEY,
  serverLinkOf,
  serverOriginOf
} from './serverOverride'

/** A device's storage, in memory. */
function storage(removes = true): {
  store: Map<string, string>
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem?: (key: string) => Promise<void>
} {
  const store = new Map<string, string>()
  return {
    store,
    getItem: async key => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value)
    },
    ...(removes
      ? {
          removeItem: async (key: string) => {
            store.delete(key)
          }
        }
      : {})
  }
}

const STABLE = 'https://app.teamstation.app'

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('a develop build’s server override', function () {
  it('is a develop build’s alone, by the app origin it was built with', function () {
    expect(isDevelopBuild(DEVELOP_APP_ORIGIN)).equals(true)
    expect(isDevelopBuild(STABLE)).equals(false)
    expect(isDevelopBuild(undefined)).equals(false)
  })

  it('takes a host name alone, as https', function () {
    expect(serverOriginOf('e2e-03.teamstation.app')).equals(
      'https://e2e-03.teamstation.app'
    )
    expect(serverOriginOf(' HTTPS://E2E-03.teamstation.app ')).equals(
      'https://e2e-03.teamstation.app'
    )
    for (const bad of [
      '',
      'localhost',
      'http://e2e-03.teamstation.app',
      'e2e-03.teamstation.app/api',
      'e2e-03.teamstation.app:8443',
      'not a host'
    ]) {
      expect(serverOriginOf(bad), bad).equals(undefined)
    }
  })

  it('is kept for the next launch, read back, and forgotten when cleared', async function () {
    const device = storage()
    expect(
      await saveServerOverride(
        device,
        DEVELOP_APP_ORIGIN,
        'e2e-03.teamstation.app'
      )
    ).equals('e2e-03.teamstation.app')
    expect(device.store.get(SERVER_KEY)).equals(
      'https://e2e-03.teamstation.app'
    )
    expect(await loadServerOverride(device, DEVELOP_APP_ORIGIN)).equals(
      'https://e2e-03.teamstation.app'
    )
    expect(await saveServerOverride(device, DEVELOP_APP_ORIGIN, null)).equals(
      null
    )
    expect(await loadServerOverride(device, DEVELOP_APP_ORIGIN)).equals(
      undefined
    )
    // A storage that cannot remove keeps an empty value, which reads as none.
    const plain = storage(false)
    await saveServerOverride(
      plain,
      DEVELOP_APP_ORIGIN,
      'e2e-03.teamstation.app'
    )
    await saveServerOverride(plain, DEVELOP_APP_ORIGIN, null)
    expect(await loadServerOverride(plain, DEVELOP_APP_ORIGIN)).equals(
      undefined
    )
  })

  it('is ignored and refused in a stable build, and a bad server is refused', async function () {
    const device = storage()
    device.store.set(SERVER_KEY, 'https://e2e-03.teamstation.app')
    expect(await loadServerOverride(device, STABLE)).equals(undefined)
    expect(
      String(
        await failure(
          async () =>
            await saveServerOverride(device, STABLE, 'e2e-03.teamstation.app')
        )
      )
    ).includes('Only a develop build')
    expect(
      String(
        await failure(
          async () =>
            await saveServerOverride(device, DEVELOP_APP_ORIGIN, 'not a host')
        )
      )
    ).includes("not a server's host name")
    // A stored value that is no longer a host is no override.
    device.store.set(SERVER_KEY, 'junk')
    expect(await loadServerOverride(device, DEVELOP_APP_ORIGIN)).equals(
      undefined
    )
  })

  it('reads the deep link that sets or clears it, and nothing else', function () {
    expect(
      serverLinkOf(
        'teamstation-develop://server?origin=https://e2e-01.teamstation.app'
      )
    ).deep.equals({ origin: 'https://e2e-01.teamstation.app' })
    expect(serverLinkOf('teamstation-develop://server?clear=1')).deep.equals({
      origin: null
    })
    expect(serverLinkOf('teamstation-develop://server')).equals(undefined)
    expect(serverLinkOf('teamstation://games/1')).equals(undefined)
    expect(serverLinkOf(null)).equals(undefined)
  })

  it('names the API under the override, or the built one', function () {
    expect(
      apiBaseFor(
        'https://e2e-01.teamstation.app',
        'https://app.teamstation.app/api/v1'
      )
    ).equals('https://e2e-01.teamstation.app/api/v1')
    expect(apiBaseFor(undefined, 'https://app.teamstation.app/api/v1')).equals(
      'https://app.teamstation.app/api/v1'
    )
  })
})
