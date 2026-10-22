import Module from 'node:module'

import { expect } from 'chai'
import { IDBDatabase as FixtureDatabase, IDBFactory } from 'fake-indexeddb'
import { before, describe, it } from 'mocha'

import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { userIdOfGumbo } from '../../common/userId'
import legacy from '../../test/legacyChatKeyRecord.json'
import { newRecord, recordToJson } from '../chat/keyRecord'
import { KEY_DATABASE, webKeyStore } from '../chat/keyStore'
import type { KeychainModule } from '../chat/keyStore.native'
import {
  openIdentityProbeStorage,
  PROBE_DATABASE,
  probeIdentityStorage
} from './chatIdentityStoreProbe'
import type * as NativeProbe from './chatIdentityStoreProbe.native'
import { runIdentityStoreProbe } from './chatIdentityStoreProbeRun'

const signal = (): AbortSignal => new AbortController().signal
async function rejected(
  work: Promise<unknown>,
  message: string
): Promise<void> {
  let error: unknown
  await work.catch((caught: unknown) => {
    error = caught
  })
  expect(String(error)).contains(message)
}

describe('isolated browser identity storage diagnostic', () => {
  it('runs the public entry against the platform factory and cleans before reporting success', async () => {
    const held = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    const factory = new IDBFactory()
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: factory
    })
    try {
      const result = await probeIdentityStorage(signal())
      expect(result.legacyRead).equals(true)
      expect(result.malformedBlocked).equals(true)
      expect(result.cleanup).equals(true)
      expect(await factory.databases()).deep.equals([])
    } finally {
      if (held == null) Reflect.deleteProperty(globalThis, 'indexedDB')
      else Object.defineProperty(globalThis, 'indexedDB', held)
    }
  })

  it('maps existence checks to only its own actual database and record', async () => {
    const factory = new IDBFactory()
    const storage = await openIdentityProbeStorage({ indexedDB: factory })
    try {
      expect(await storage.store.exists()).equals(false)
      await storage.install(JSON.stringify(legacy))
      expect(await storage.store.exists()).equals(true)
      expect((await factory.databases()).map(row => row.name)).deep.equals([
        PROBE_DATABASE
      ])
    } finally {
      await storage.cleanup()
    }
  })

  it('reports an aborted real install transaction and still cleans the allocated database', async () => {
    const factory = new IDBFactory()
    const transaction = Object.getOwnPropertyDescriptor(
      FixtureDatabase.prototype,
      'transaction'
    )!
    FixtureDatabase.prototype.transaction = function (names, mode, options) {
      const opened = (transaction.value as IDBDatabase['transaction']).call(
        this,
        names,
        mode,
        options
      )
      if (mode === 'readwrite')
        queueMicrotask(() => {
          opened.abort()
        })
      return opened
    }
    try {
      await rejected(
        runIdentityStoreProbe(
          async () => await openIdentityProbeStorage({ indexedDB: factory }),
          signal()
        ),
        'Compatibility write failed'
      )
      expect(await factory.databases()).deep.equals([])
    } finally {
      Object.defineProperty(
        FixtureDatabase.prototype,
        'transaction',
        transaction
      )
    }
  })

  it('keeps a blocked cleanup visible until another connection releases the owned database', async () => {
    const factory = new IDBFactory()
    const storage = await openIdentityProbeStorage({ indexedDB: factory })
    const request = factory.open(PROBE_DATABASE)
    const held = await new Promise<IDBDatabase>(resolve => {
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    try {
      await rejected(storage.cleanup(), 'Compatibility cleanup failed')
      expect((await factory.databases()).map(row => row.name)).deep.equals([
        PROBE_DATABASE
      ])
    } finally {
      held.close()
    }
    const deadline = Date.now() + 1000
    while ((await factory.databases()).length > 0 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))
    expect(await factory.databases()).deep.equals([])
  })

  it('uses real IndexedDB transactions and crypto while preserving the normal store', async () => {
    const factory = new IDBFactory()
    const normal = webKeyStore({ indexedDB: factory })
    const original = newRecord(userIdOfGumbo(8), 'cdv_normal', newDeviceKeys())
    await normal.save(original)
    const result = await runIdentityStoreProbe(
      async () => await openIdentityProbeStorage({ indexedDB: factory }),
      signal()
    )
    expect(result).deep.equals({
      legacyRead: true,
      refusedSavePreserved: true,
      canonicalSave: true,
      malformedBlocked: true,
      enrollmentAttempts: 0,
      wipeAttempts: 0,
      cleanup: true,
      refusal: 'injected adapter write refusal'
    })
    expect(recordToJson((await normal.load())!)).equals(recordToJson(original))
    expect((await factory.databases()).map(row => row.name)).deep.equals([
      KEY_DATABASE
    ])
  })

  for (const version of [1, 2])
    it(`refuses occupied version ${version} without changing its schema or data`, async () => {
      const factory = new IDBFactory()
      const request = factory.open(PROBE_DATABASE, version)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('existing')
      }
      const db = await new Promise<IDBDatabase>(resolve => {
        request.onsuccess = () => {
          resolve(request.result)
        }
      })
      const transaction = db.transaction('existing', 'readwrite')
      transaction.objectStore('existing').put('kept', 'owner')
      await new Promise(resolve => {
        transaction.oncomplete = resolve
      })
      await rejected(
        openIdentityProbeStorage({ indexedDB: factory }),
        version === 1 ? 'occupied' : 'unavailable'
      )
      expect(db.version).equals(version)
      expect([...db.objectStoreNames]).deep.equals(['existing'])
      const read = db
        .transaction('existing')
        .objectStore('existing')
        .get('owner')
      expect(
        await new Promise(resolve => {
          read.onsuccess = () => {
            resolve(read.result)
          }
        })
      ).equals('kept')
      db.close()
    })

  it('rejects a second owner and cleans an allocation delivered after cancellation', async () => {
    const factory = new IDBFactory()
    const first = await openIdentityProbeStorage({ indexedDB: factory })
    await rejected(
      openIdentityProbeStorage({ indexedDB: factory }),
      'already running'
    )
    await first.cleanup()
    const controller = new AbortController()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const work = runIdentityStoreProbe(async () => {
      const storage = await openIdentityProbeStorage({ indexedDB: factory })
      await held
      return storage
    }, controller.signal)
    controller.abort()
    release()
    await rejected(work, 'aborted')
    expect(await factory.databases()).deep.equals([])
  })

  it('fails on a real write refusal and still cleans its exact owned database', async () => {
    const factory = new IDBFactory()
    const subtle = new Proxy(globalThis.crypto.subtle, {
      get(target, key) {
        if (key === 'encrypt')
          return async () => {
            throw new Error('Storage denied')
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await rejected(
      runIdentityStoreProbe(
        async () =>
          await openIdentityProbeStorage({ indexedDB: factory, subtle }),
        signal()
      ),
      'Storage denied'
    )
    expect(await factory.databases()).deep.equals([])
  })
})

interface KeychainFixture {
  rows: Map<string, { username: string; password: string }>
  calls: string[]
  control: {
    refuseWrite: boolean
    refuseReset: boolean
    falseAfterReset: boolean
  }
  module: KeychainModule
}

function keychainFixture(): KeychainFixture {
  const rows = new Map<string, { username: string; password: string }>()
  const calls: string[] = []
  const control = {
    refuseWrite: false,
    refuseReset: false,
    falseAfterReset: false
  }
  const module = {
    ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only' },
    hasGenericPassword: async (options: { service: string }) => {
      calls.push('has ' + options.service)
      return rows.has(options.service)
    },
    getGenericPassword: async (options: { service: string }) => {
      calls.push('get ' + options.service)
      const value = rows.get(options.service)
      return value == null
        ? false
        : { ...value, service: options.service, storage: 'keychain' }
    },
    setGenericPassword: async (
      username: string,
      password: string,
      options: { service: string }
    ) => {
      calls.push('set ' + options.service)
      if (control.refuseWrite) return false
      rows.set(options.service, { username, password })
      return { service: options.service, storage: 'keychain' }
    },
    resetGenericPassword: async (options: { service: string }) => {
      calls.push('reset ' + options.service)
      if (control.refuseReset) return false
      const removed = rows.delete(options.service)
      return !control.falseAfterReset && removed
    }
  }
  return { rows, calls, control, module: module as unknown as KeychainModule }
}

describe('isolated native identity storage diagnostic', () => {
  let native: typeof NativeProbe
  let platform: KeychainFixture
  before(async () => {
    const path = require.resolve('react-native-keychain')
    const stand = new Module(path)
    stand.filename = path
    stand.loaded = true
    platform = keychainFixture()
    stand.exports = platform.module
    require.cache[path] = stand
    native = await import('./chatIdentityStoreProbe.native')
  })

  it('runs the public entry with the platform module and reports only after cleanup', async () => {
    platform.rows.set('app.teamstation.chat', {
      username: 'chat',
      password: 'protected'
    })
    const result = await native.probeIdentityStorage(signal())
    expect(result.legacyRead).equals(true)
    expect(result.malformedBlocked).equals(true)
    expect(result.cleanup).equals(true)
    expect([...platform.rows]).deep.equals([
      ['app.teamstation.chat', { username: 'chat', password: 'protected' }]
    ])
    expect(
      platform.calls.every(call => call.endsWith(native.PROBE_SERVICE))
    ).equals(true)
  })

  it('reports a refused install and keeps the allocated item available for cleanup', async () => {
    const fixture = keychainFixture()
    const storage = await native.openIdentityProbeStorage(fixture.module)
    try {
      expect(await storage.store.exists()).equals(true)
      fixture.control.refuseWrite = true
      await rejected(
        storage.install(JSON.stringify(legacy)),
        'Compatibility storage unavailable'
      )
      expect(fixture.rows.get(native.PROBE_SERVICE)?.password).equals(
        'allocated'
      )
      expect(
        fixture.calls.every(call => call.endsWith(native.PROBE_SERVICE))
      ).equals(true)
    } finally {
      await storage.cleanup()
    }
    expect(fixture.rows.size).equals(0)
  })

  it('uses the production native adapter solely under its synthetic service', async () => {
    const fixture = keychainFixture()
    fixture.rows.set('app.teamstation.chat', {
      username: 'chat',
      password: 'protected'
    })
    const result = await runIdentityStoreProbe(
      async () => await native.openIdentityProbeStorage(fixture.module),
      signal()
    )
    expect(result.cleanup).equals(true)
    expect(result.enrollmentAttempts).equals(0)
    expect([...fixture.rows]).deep.equals([
      ['app.teamstation.chat', { username: 'chat', password: 'protected' }]
    ])
    expect(
      fixture.calls.every(call => call.endsWith(native.PROBE_SERVICE))
    ).equals(true)
  })

  it('never overwrites or resets a namespace another writer occupies', async () => {
    const fixture = keychainFixture()
    fixture.rows.set(native.PROBE_SERVICE, {
      username: 'owner',
      password: 'existing'
    })
    await rejected(native.openIdentityProbeStorage(fixture.module), 'occupied')
    expect(fixture.calls).deep.equals([
      'has ' + native.PROBE_SERVICE,
      'get ' + native.PROBE_SERVICE
    ])
    expect(fixture.rows.get(native.PROBE_SERVICE)?.password).equals('existing')
  })

  it('clears its own leftover from a run stopped before cleanup, then runs', async () => {
    for (const password of ['allocated', JSON.stringify(legacy)]) {
      const fixture = keychainFixture()
      fixture.rows.set('app.teamstation.chat', {
        username: 'chat',
        password: 'protected'
      })
      fixture.rows.set(native.PROBE_SERVICE, { username: 'chat', password })
      const result = await runIdentityStoreProbe(
        async () => await native.openIdentityProbeStorage(fixture.module),
        signal()
      )
      expect(result.cleanup).equals(true)
      expect([...fixture.rows]).deep.equals([
        ['app.teamstation.chat', { username: 'chat', password: 'protected' }]
      ])
      expect(fixture.calls.slice(0, 3)).deep.equals([
        'has ' + native.PROBE_SERVICE,
        'get ' + native.PROBE_SERVICE,
        'reset ' + native.PROBE_SERVICE
      ])
      expect(
        fixture.calls.every(call => call.endsWith(native.PROBE_SERVICE))
      ).equals(true)
    }
  })

  it('stays occupied when its leftover cannot be cleared', async () => {
    const fixture = keychainFixture()
    fixture.rows.set(native.PROBE_SERVICE, {
      username: 'chat',
      password: 'allocated'
    })
    fixture.control.refuseReset = true
    await rejected(native.openIdentityProbeStorage(fixture.module), 'occupied')
    expect(fixture.calls.some(call => call.startsWith('set'))).equals(false)
    expect(fixture.rows.get(native.PROBE_SERVICE)?.password).equals('allocated')
    fixture.control.refuseReset = false
    const storage = await native.openIdentityProbeStorage(fixture.module)
    await storage.cleanup()
    expect(fixture.rows.size).equals(0)
  })

  it('releases exclusive ownership when allocation is refused and after cancellation', async () => {
    const fixture = keychainFixture()
    fixture.control.refuseWrite = true
    await rejected(
      native.openIdentityProbeStorage(fixture.module),
      'unavailable'
    )
    expect(fixture.calls.some(call => call.startsWith('reset'))).equals(false)
    fixture.control.refuseWrite = false
    const storage = await native.openIdentityProbeStorage(fixture.module)
    await rejected(
      native.openIdentityProbeStorage(fixture.module),
      'already running'
    )
    await storage.cleanup()
    const controller = new AbortController()
    controller.abort()
    await rejected(
      runIdentityStoreProbe(
        async () => await native.openIdentityProbeStorage(fixture.module),
        controller.signal
      ),
      'aborted'
    )
    expect(fixture.rows.size).equals(0)
  })

  it('does not return success when the OS adapter keeps an item after reset', async () => {
    const fixture = keychainFixture()
    fixture.control.refuseReset = true
    await rejected(
      runIdentityStoreProbe(
        async () => await native.openIdentityProbeStorage(fixture.module),
        signal()
      ),
      'cleanup failed'
    )
    expect(fixture.rows.has(native.PROBE_SERVICE)).equals(true)
  })

  it('keeps an explicit reset refusal visible even if the item has disappeared', async () => {
    const fixture = keychainFixture()
    fixture.control.falseAfterReset = true
    await rejected(
      runIdentityStoreProbe(
        async () => await native.openIdentityProbeStorage(fixture.module),
        signal()
      ),
      'cleanup failed'
    )
    expect(fixture.rows.size).equals(0)
  })
})
