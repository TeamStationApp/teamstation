import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PushRegistration, PushSwitches } from '../../common/api'
import {
  type NotificationSwitches,
  readAsked,
  readSwitches,
  SWITCHES_OFF,
  writeAsked
} from '../platform/notificationSwitches'
import {
  type PushClient,
  type PushState,
  sharedPushDevice
} from '../platform/pushState'
import type { UserSettingStorage } from '../platform/userSetting'
import { answerAsk, startAsk } from './notificationAsk'

const U = 'usr_1'
const BOTH: NotificationSwitches = { messages: true, rsvpEvents: true }

function memory(): UserSettingStorage {
  const kept = new Map<string, string>()
  return {
    getItem: async key => kept.get(key) ?? null,
    setItem: async (key, value) => {
      kept.set(key, value)
    }
  }
}

/**
 * The shared device engine over a device in `permission`, whose system
 * question answers `answer`: what it registers and patches, and how often
 * it asked.
 */
function device(
  permission: PushState,
  answer: PushState = permission
): {
  engine: ReturnType<typeof sharedPushDevice>
  client: PushClient
  storage: UserSettingStorage
  registered: PushRegistration[]
  patched: Array<[string, Partial<PushSwitches>]>
  asks: () => number
} {
  const storage = memory()
  const registered: PushRegistration[] = []
  const patched: Array<[string, Partial<PushSwitches>]> = []
  let now = permission
  let asks = 0
  const client: PushClient = {
    webPushKey: async () => 'key',
    registerPush: async registration => {
      registered.push(registration)
      return `reg-${registered.length}`
    },
    updatePush: async (id, change) => {
      patched.push([id, change])
      return { ...SWITCHES_OFF, leagueManagement: true, ...change }
    }
  }
  // Every part a platform gives, whichever of them this engine reads.
  const platform = {
    state: async (): Promise<PushState> => now,
    ask: async (): Promise<void> => {
      asks++
      if (now === 'prompt') now = answer
    },
    register: async (
      _client: PushClient,
      switches: NotificationSwitches
    ): Promise<string> =>
      await client.registerPush({
        platform: 'web',
        address: '{}',
        environment: 'production',
        ...switches
      }),
    letGo: async (): Promise<void> => undefined,
    setActiveConversation: (): void => undefined,
    clearConversation: async (): Promise<void> => undefined,
    signedIn: (): void => undefined
  }
  const engine = sharedPushDevice(platform, { storage, retryMs: [] })
  return {
    engine,
    client,
    storage,
    registered,
    patched,
    asks: () => asks
  }
}

describe('the app’s ask about notifications', function () {
  it('turns both switches on with no question on a device allowed already, and keeps that it asked', async function () {
    const phone = device('granted')
    const opened = await startAsk(phone.engine, phone.client, U, {
      storage: phone.storage
    })
    expect(opened).equals(undefined)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    expect(await readAsked(U, phone.storage)).equals(true)
    // Through the shared engine: the registration goes with both on.
    expect(phone.registered.map(r => [r.messages, r.rsvpEvents])).deep.equals([
      [true, true]
    ])
    expect(phone.asks()).equals(0)
    // Never again, and nothing changed by it after.
    expect(
      await startAsk(phone.engine, phone.client, U, { storage: phone.storage })
    ).equals(undefined)
    expect(phone.registered).length(1)
  })

  it('does nothing, and keeps nothing, on a device that cannot notify', async function () {
    const phone = device('unsupported')
    expect(
      await startAsk(phone.engine, phone.client, U, { storage: phone.storage })
    ).equals(undefined)
    expect(await readAsked(U, phone.storage)).equals(false)
    expect(await readSwitches(U, phone.storage)).deep.equals(SWITCHES_OFF)
  })

  it('asks nobody it has asked on this device, whatever the permission now', async function () {
    for (const permission of ['prompt', 'denied', 'granted'] as const) {
      const phone = device(permission)
      await writeAsked(U, phone.storage)
      expect(
        await startAsk(phone.engine, phone.client, U, {
          storage: phone.storage
        }),
        permission
      ).equals(undefined)
      expect(await readSwitches(U, phone.storage)).deep.equals(SWITCHES_OFF)
      expect(phone.registered).length(0)
      // Someone else on the same device is asked.
      expect(
        await startAsk(phone.engine, phone.client, 'usr_2', {
          storage: phone.storage
        })
      ).equals(permission === 'granted' ? undefined : permission)
    }
  })

  it('shows the question to a device not decided or refused at the system', async function () {
    for (const permission of ['prompt', 'denied'] as const) {
      const phone = device(permission)
      expect(
        await startAsk(phone.engine, phone.client, U, {
          storage: phone.storage
        })
      ).equals(permission)
      // Shown is not answered: nothing kept until an answer.
      expect(await readAsked(U, phone.storage)).equals(false)
    }
  })

  it('keeps Not Now and changes nothing else', async function () {
    for (const permission of ['prompt', 'denied'] as const) {
      const phone = device(permission)
      let opened = 0
      expect(
        await answerAsk(phone.engine, phone.client, U, permission, 'notNow', {
          storage: phone.storage,
          openSettings: async () => {
            opened++
            return true
          }
        })
      ).equals('done')
      expect(await readAsked(U, phone.storage)).equals(true)
      expect(await readSwitches(U, phone.storage)).deep.equals(SWITCHES_OFF)
      expect(phone.asks()).equals(0)
      expect(opened).equals(0)
      expect(phone.registered).length(0)
      expect(
        await startAsk(phone.engine, phone.client, U, {
          storage: phone.storage
        })
      ).equals(undefined)
    }
  })

  it('on Continue turns both on and asks the system, registering once allowed', async function () {
    const phone = device('prompt', 'granted')
    expect(
      await answerAsk(phone.engine, phone.client, U, 'prompt', 'continue', {
        storage: phone.storage
      })
    ).equals('done')
    expect(phone.asks()).equals(1)
    expect(await readAsked(U, phone.storage)).equals(true)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    expect(
      phone.registered.map(r => [r.messages, r.rsvpEvents]).at(-1)
    ).deep.equals([true, true])
  })

  it('keeps both on when the system’s question is refused, and registers nothing', async function () {
    const phone = device('prompt', 'denied')
    await answerAsk(phone.engine, phone.client, U, 'prompt', 'continue', {
      storage: phone.storage
    })
    expect(phone.asks()).equals(1)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    expect(await readAsked(U, phone.storage)).equals(true)
    expect(phone.registered).length(0)
  })

  it('on Continue after a refusal turns both on and opens this device’s settings', async function () {
    const phone = device('denied')
    let opened = 0
    expect(
      await answerAsk(phone.engine, phone.client, U, 'denied', 'continue', {
        storage: phone.storage,
        openSettings: async () => {
          opened++
          return true
        }
      })
    ).equals('done')
    expect(opened).equals(1)
    expect(phone.asks()).equals(0)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    expect(await readAsked(U, phone.storage)).equals(true)
  })

  it('opens the settings after a refusal once the switches are stored, not once the server has them', async function () {
    // Registered before the person turned notifications off at the system:
    // the switch change patches that registration, over a link that hangs.
    const phone = device('granted')
    await phone.engine.sync(phone.client, U)
    expect(phone.registered).length(1)
    let patching = 0
    phone.client.updatePush = async () => {
      patching++
      return await new Promise(() => {})
    }
    let opened = 0
    expect(
      await answerAsk(phone.engine, phone.client, U, 'denied', 'continue', {
        storage: phone.storage,
        openSettings: async () => {
          opened++
          return true
        }
      })
    ).equals('done')
    expect(opened).equals(1)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    // The server is still being told, behind.
    expect(patching).equals(1)
  })

  it('answers the hint where the settings cannot be opened, as on the web', async function () {
    for (const openSettings of [
      async () => false,
      async () => {
        throw new Error('No settings')
      },
      undefined
    ]) {
      const phone = device('denied')
      expect(
        await answerAsk(phone.engine, phone.client, U, 'denied', 'continue', {
          storage: phone.storage,
          openSettings
        })
      ).equals('hint')
      expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
      expect(await readAsked(U, phone.storage)).equals(true)
    }
  })

  it('keeps its record in this device’s own storage by default', async function () {
    const phone = device('unsupported')
    expect(await startAsk(phone.engine, phone.client, 'usr_default')).equals(
      undefined
    )
    expect(
      await answerAsk(
        phone.engine,
        phone.client,
        'usr_default',
        'denied',
        'notNow'
      )
    ).equals('done')
  })
})
