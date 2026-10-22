import { userIdOfGumbo } from '../../common/userId'
import legacy from '../../test/legacyChatKeyRecord.json'
import { type ChatKeysClient, ensureEnrolled } from '../chat/engine/links'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../chat/keyRecord'

export interface IdentityProbeStorage {
  store: ChatKeyStore
  install: (text: string) => Promise<void>
  fingerprint: () => Promise<string>
  refuseNextSave: () => void
  cleanup: () => Promise<void>
}

export interface IdentityProbeResult {
  legacyRead: true
  refusedSavePreserved: true
  canonicalSave: true
  malformedBlocked: true
  enrollmentAttempts: 0
  wipeAttempts: 0
  cleanup: true
  refusal: 'injected adapter write refusal'
}

function requireProbe(value: boolean): asserts value {
  if (!value) throw new Error('Compatibility check failed')
}

/** Real platform persistence in a separately allocated synthetic namespace. */
export async function runIdentityStoreProbe(
  open: () => Promise<IdentityProbeStorage>,
  signal: AbortSignal
): Promise<IdentityProbeResult> {
  const storage = await open()
  try {
    signal.throwIfAborted()
    const text = JSON.stringify(legacy)
    await storage.install(text)
    const record = await storage.store.load()
    requireProbe(record != null)
    requireProbe(record.userId === userIdOfGumbo(42))
    const expected = {
      ...legacy,
      version: 2,
      userId: userIdOfGumbo(42),
      pins: {
        [userIdOfGumbo(7)]: legacy.pins[7],
        [userIdOfGumbo(42)]: legacy.pins[42]
      },
      previousPins: { [userIdOfGumbo(7)]: legacy.previousPins[7] },
      logs: {
        cnv_legacy: {
          ...legacy.logs.cnv_legacy,
          members: legacy.logs.cnv_legacy.members.map(userIdOfGumbo),
          resets: legacy.logs.cnv_legacy.resets.map(row => ({
            ...row,
            userId: userIdOfGumbo(row.userId)
          }))
        }
      }
    }
    const expectedText = recordToJson(recordFromJson(JSON.stringify(expected)))
    requireProbe(recordToJson(record) === expectedText)
    const before = await storage.fingerprint()
    signal.throwIfAborted()
    storage.refuseNextSave()
    let refused = false
    await storage.store.save(record).catch(() => {
      refused = true
    })
    requireProbe(refused && (await storage.fingerprint()) === before)
    requireProbe(
      recordToJson((await storage.store.load())!) === recordToJson(record)
    )
    await storage.store.save(record)
    requireProbe(recordToJson((await storage.store.load())!) === expectedText)
    let enrollmentAttempts = 0
    let wipeAttempts = 0
    const guardedStore: ChatKeyStore = {
      ...storage.store,
      wipe: async () => {
        wipeAttempts += 1
        throw new Error('Diagnostic wipe refused')
      }
    }
    const client = new Proxy(
      {},
      {
        get: () => async () => {
          enrollmentAttempts += 1
          throw new Error('Diagnostic network access refused')
        }
      }
    ) as ChatKeysClient
    for (const malformed of [
      { ...legacy, version: 9 },
      {
        ...legacy,
        device: {
          ...legacy.device,
          box: { ...legacy.device.box, secretKey: 'AA' }
        }
      },
      {
        ...legacy,
        device: {
          ...legacy.device,
          box: { ...legacy.device.box, secretKey: '*'.repeat(43) }
        }
      }
    ]) {
      signal.throwIfAborted()
      await storage.install(JSON.stringify(malformed))
      const held = await storage.fingerprint()
      let blocked = false
      try {
        recordFromJson(JSON.stringify(malformed))
      } catch {
        blocked = true
      }
      requireProbe(blocked)
      blocked = false
      await ensureEnrolled({
        client,
        store: guardedStore,
        userId: userIdOfGumbo(42),
        device: { name: 'Compatibility fixture', platform: 'web' }
      }).catch(() => {
        blocked = true
      })
      requireProbe(blocked && enrollmentAttempts === 0 && wipeAttempts === 0)
      requireProbe((await storage.fingerprint()) === held)
    }
    // Restore the exact synthetic baseline before releasing its namespace.
    await storage.install(text)
    signal.throwIfAborted()
  } finally {
    await storage.cleanup()
  }
  return {
    legacyRead: true,
    refusedSavePreserved: true,
    canonicalSave: true,
    malformedBlocked: true,
    enrollmentAttempts: 0,
    wipeAttempts: 0,
    cleanup: true,
    refusal: 'injected adapter write refusal'
  }
}
