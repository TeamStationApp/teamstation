import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PushRegistration, PushSwitches } from '../../common/api'
import {
  ALL_ON,
  type NotificationSwitches,
  readAsked,
  readSwitches,
  SWITCHES_OFF,
  writeAsked,
  writeSwitches
} from '../platform/notificationSwitches'
import {
  type PushClient,
  type PushState,
  sharedPushDevice
} from '../platform/pushState'
import type { UserSettingStorage } from '../platform/userSetting'
import { answerAsk, startAsk } from './notificationAsk'

const U = 'usr_1'
const BOTH: NotificationSwitches = ALL_ON
/** A first ask, as the RSVP and messaging asks always are. */
const PROMPT = { question: 'prompt', first: true } as const
const DENIED = { question: 'denied', first: true } as const

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
  it('turns all three switches on with no question on a device allowed already, and keeps that it asked', async function () {
    const phone = device('granted')
    const opened = await startAsk(phone.engine, phone.client, U, {
      storage: phone.storage
    })
    expect(opened).equals(undefined)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    expect(await readAsked(U, phone.storage)).equals(true)
    // Through the shared engine: the registration goes with all three on.
    expect(
      phone.registered.map(r => [r.messages, r.rsvpEvents, r.leagueManagement])
    ).deep.equals([[true, true, true]])
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
      ).deep.equals(
        permission === 'granted'
          ? undefined
          : { question: permission, first: true }
      )
    }
  })

  it('shows the question to a device not decided or refused at the system', async function () {
    for (const permission of ['prompt', 'denied'] as const) {
      const phone = device(permission)
      expect(
        await startAsk(phone.engine, phone.client, U, {
          storage: phone.storage
        })
      ).deep.equals({ question: permission, first: true })
      // Shown is not answered: nothing kept until an answer.
      expect(await readAsked(U, phone.storage)).equals(false)
    }
  })

  it('keeps Not Now and changes nothing else', async function () {
    for (const permission of ['prompt', 'denied'] as const) {
      const phone = device(permission)
      let opened = 0
      expect(
        await answerAsk(
          phone.engine,
          phone.client,
          U,
          { question: permission, first: true },
          'notNow',
          {
            storage: phone.storage,
            openSettings: async () => {
              opened++
              return true
            }
          }
        )
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

  it('on Continue turns all three on and asks the system, registering once allowed', async function () {
    const phone = device('prompt', 'granted')
    expect(
      await answerAsk(phone.engine, phone.client, U, PROMPT, 'continue', {
        storage: phone.storage
      })
    ).equals('done')
    expect(phone.asks()).equals(1)
    expect(await readAsked(U, phone.storage)).equals(true)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    expect(
      phone.registered
        .map(r => [r.messages, r.rsvpEvents, r.leagueManagement])
        .at(-1)
    ).deep.equals([true, true, true])
  })

  it('keeps all three on when the system’s question is refused, and registers nothing', async function () {
    const phone = device('prompt', 'denied')
    await answerAsk(phone.engine, phone.client, U, PROMPT, 'continue', {
      storage: phone.storage
    })
    expect(phone.asks()).equals(1)
    expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
    expect(await readAsked(U, phone.storage)).equals(true)
    expect(phone.registered).length(0)
  })

  it('on Continue after a refusal turns all three on and opens this device’s settings', async function () {
    const phone = device('denied')
    let opened = 0
    expect(
      await answerAsk(phone.engine, phone.client, U, DENIED, 'continue', {
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
      await answerAsk(phone.engine, phone.client, U, DENIED, 'continue', {
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
        await answerAsk(phone.engine, phone.client, U, DENIED, 'continue', {
          storage: phone.storage,
          openSettings
        })
      ).equals('hint')
      expect(await readSwitches(U, phone.storage)).deep.equals(BOTH)
      expect(await readAsked(U, phone.storage)).equals(true)
    }
  })

  describe('a League management ask, past the asked record', function () {
    /** Messages and RSVP events as the person left them before. */
    const KEPT: NotificationSwitches = {
      messages: false,
      rsvpEvents: true,
      leagueManagement: false
    }
    /** A device that asked U before (RSVP answered Not Now), with `KEPT`. */
    async function askedBefore(
      permission: PushState,
      answer: PushState = permission
    ): Promise<ReturnType<typeof device>> {
      const phone = device(permission, answer)
      await writeAsked(U, phone.storage)
      await writeSwitches(U, KEPT, phone.storage)
      return phone
    }
    const again = async (
      phone: ReturnType<typeof device>
    ): ReturnType<typeof startAsk> =>
      await startAsk(phone.engine, phone.client, U, {
        storage: phone.storage,
        again: true
      })

    it('shows the question again when not decided, while an RSVP ask stays silent', async function () {
      for (const permission of ['prompt', 'denied'] as const) {
        const phone = await askedBefore(permission)
        expect(
          await startAsk(phone.engine, phone.client, U, {
            storage: phone.storage
          })
        ).equals(undefined)
        expect(await again(phone)).deep.equals({
          question: permission,
          first: false
        })
        expect(await readSwitches(U, phone.storage)).deep.equals(KEPT)
      }
    })

    it('turns on only League management, with no question, when allowed', async function () {
      const phone = await askedBefore('granted')
      expect(await again(phone)).equals(undefined)
      expect(await readSwitches(U, phone.storage)).deep.equals({
        ...KEPT,
        leagueManagement: true
      })
      expect(phone.asks()).equals(0)
      // Messages kept on stays on too.
      const on = await askedBefore('granted')
      await writeSwitches(U, { ...KEPT, messages: true }, on.storage)
      await again(on)
      expect(await readSwitches(U, on.storage)).deep.equals({
        messages: true,
        rsvpEvents: true,
        leagueManagement: true
      })
    })

    it('turns on only League management at Continue, and asks the system', async function () {
      const phone = await askedBefore('prompt', 'granted')
      const start = await again(phone)
      expect(start).deep.equals({ question: 'prompt', first: false })
      expect(
        await answerAsk(phone.engine, phone.client, U, start!, 'continue', {
          storage: phone.storage
        })
      ).equals('done')
      expect(phone.asks()).equals(1)
      expect(await readSwitches(U, phone.storage)).deep.equals({
        ...KEPT,
        leagueManagement: true
      })
      expect(
        phone.registered
          .map(r => [r.messages, r.rsvpEvents, r.leagueManagement])
          .at(-1)
      ).deep.equals([false, true, true])
    })

    it('changes nothing at Not Now', async function () {
      const phone = await askedBefore('prompt')
      const start = await again(phone)
      await answerAsk(phone.engine, phone.client, U, start!, 'notNow', {
        storage: phone.storage
      })
      expect(await readSwitches(U, phone.storage)).deep.equals(KEPT)
      expect(phone.asks()).equals(0)
      expect(phone.registered).length(0)
    })

    it('takes the refused path when refused at the system', async function () {
      const phone = await askedBefore('denied')
      const start = await again(phone)
      let opened = 0
      expect(
        await answerAsk(phone.engine, phone.client, U, start!, 'continue', {
          storage: phone.storage,
          openSettings: async () => {
            opened++
            return true
          }
        })
      ).equals('done')
      expect(opened).equals(1)
      expect(await readSwitches(U, phone.storage)).deep.equals({
        ...KEPT,
        leagueManagement: true
      })
      // Where settings cannot be opened, the hint.
      const web = await askedBefore('denied')
      expect(
        await answerAsk(
          web.engine,
          web.client,
          U,
          (await again(web))!,
          'continue',
          { storage: web.storage }
        )
      ).equals('hint')
    })

    it('is the first ask on a device never asked: all three on, and the ask kept', async function () {
      const granted = device('granted')
      expect(await again(granted)).equals(undefined)
      expect(await readSwitches(U, granted.storage)).deep.equals(ALL_ON)
      expect(await readAsked(U, granted.storage)).equals(true)

      const prompt = device('prompt', 'granted')
      const start = await again(prompt)
      expect(start).deep.equals({ question: 'prompt', first: true })
      await answerAsk(prompt.engine, prompt.client, U, start!, 'continue', {
        storage: prompt.storage
      })
      expect(await readSwitches(U, prompt.storage)).deep.equals(ALL_ON)
      expect(await readAsked(U, prompt.storage)).equals(true)
      // An RSVP ask after it stays silent.
      expect(
        await startAsk(prompt.engine, prompt.client, U, {
          storage: prompt.storage
        })
      ).equals(undefined)
    })

    it('does nothing on a device that cannot notify', async function () {
      const phone = await askedBefore('unsupported')
      expect(await again(phone)).equals(undefined)
      expect(await readSwitches(U, phone.storage)).deep.equals(KEPT)
    })
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
        DENIED,
        'notNow'
      )
    ).equals('done')
  })
})
