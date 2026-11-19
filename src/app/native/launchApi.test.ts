import { expect } from 'chai'
import { describe, it } from 'mocha'

import { apiBaseUrl } from './config'
import { launchApi, launchApiOf } from './launchApi'
import { DEVELOP_APP_ORIGIN, SERVER_KEY } from './serverOverride'

/** A device's storage holding `values`, counting its reads. */
function storage(values: Record<string, string>): {
  reads: number
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
} {
  const held = {
    reads: 0,
    getItem: async (key: string) => {
      held.reads++
      return values[key] ?? null
    },
    setItem: async () => undefined
  }
  return held
}

const BUILT = 'https://app.example.test/api/v1'

describe('the API a launch talks to', function () {
  it('is a develop build’s server override, or else the built one', async function () {
    const pointed = storage({ [SERVER_KEY]: 'https://stack.example.test' })
    expect(await launchApiOf(pointed, DEVELOP_APP_ORIGIN, BUILT)).equals(
      'https://stack.example.test/api/v1'
    )
    // Nothing kept, or a stable build, which never reads one.
    expect(await launchApiOf(storage({}), DEVELOP_APP_ORIGIN, BUILT)).equals(
      BUILT
    )
    const stable = storage({ [SERVER_KEY]: 'https://stack.example.test' })
    expect(
      await launchApiOf(stable, 'https://app.teamstation.app', BUILT)
    ).equals(BUILT)
    expect(stable.reads).equals(0)
  })

  it('is this build’s, worked out once for the launch', async function () {
    const first = launchApi()
    expect(await first).equals(apiBaseUrl)
    expect(await launchApi()).equals(apiBaseUrl)
  })
})
