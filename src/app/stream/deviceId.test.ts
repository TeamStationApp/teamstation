import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { DEVICE_ID_KEY, deviceIdStore, randomUuid } from './deviceId'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function memory(initial: Record<string, string> = {}): PreferenceStorage & {
  values: Record<string, string>
  writes: number
} {
  const values = { ...initial }
  const store = {
    values,
    writes: 0,
    getItem: async (key: string) => values[key] ?? null,
    setItem: async (key: string, value: string) => {
      store.writes += 1
      values[key] = value
    }
  }
  return store
}

describe('this install’s device id', function () {
  it('is made once, kept, and the same on every later call', async function () {
    const storage = memory()
    let made = 0
    const id = deviceIdStore(storage, () => {
      made += 1
      return randomUuid()
    })
    const [first, second] = await Promise.all([id(), id()])
    expect(first).match(UUID)
    expect(second).equals(first)
    expect(await id()).equals(first)
    expect(made).equals(1)
    expect(storage.writes).equals(1)
    expect(storage.values[DEVICE_ID_KEY]).equals(first)
  })

  it('is read back after a relaunch rather than made again', async function () {
    const kept = '00000000-0000-4000-8000-000000000001'
    const storage = memory({ [DEVICE_ID_KEY]: kept })
    const relaunched = deviceIdStore(storage, () => {
      throw new Error('made a new id')
    })
    expect(await relaunched()).equals(kept)
    expect(storage.writes).equals(0)
  })

  it('replaces a value that is not an id, and survives storage that refuses', async function () {
    const storage = memory({ [DEVICE_ID_KEY]: 'not an id' })
    const replaced = await deviceIdStore(storage)()
    expect(replaced).match(UUID)
    expect(storage.values[DEVICE_ID_KEY]).equals(replaced)
    const broken: PreferenceStorage = {
      getItem: async () => {
        throw new Error('locked')
      },
      setItem: async () => {
        throw new Error('full')
      }
    }
    const id = deviceIdStore(
      broken,
      () => '00000000-0000-4000-8000-000000000002'
    )
    expect(await id()).equals('00000000-0000-4000-8000-000000000002')
    expect(await id()).equals('00000000-0000-4000-8000-000000000002')
  })

  it('is a version 4 UUID from the runtime’s randomness, or Math.random without one', function () {
    expect(randomUuid(bytes => bytes.fill(0xff))).equals(
      'ffffffff-ffff-4fff-bfff-ffffffffffff'
    )
    const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined
    })
    try {
      expect(randomUuid()).match(UUID)
    } finally {
      if (crypto != null) Object.defineProperty(globalThis, 'crypto', crypto)
    }
    expect(randomUuid()).match(UUID)
  })
})
