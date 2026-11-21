import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { TeamStationClient } from '../../common/api'
import { depsOf, type WakeCase, wakeCases } from '../../test/chatWakeCases'
import type { PushClient } from '../platform/pushState'
import type * as TaskModule from './chatWakeTask.native'

/**
 * The Android app's push tasks, over the real chat crypto of
 * `chatWakeCases.ts`. React Native and the two native stores are replaced
 * in the module cache by stand-ins of this test's, as
 * `pushDevice.native.test.ts` does, since their real modules need the phone.
 */
const stand = (name: string, exports: unknown): void => {
  const path = require.resolve(name)
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports
  } as unknown as NodeJS.Module
}
const file = require.resolve('./chatWakeTask.native')
const nativeSpec = require.resolve('./NativePush')
const standIns = [
  'react-native',
  'react-native-keychain',
  '@react-native-async-storage/async-storage'
]
/** Modules that read a stand-in at import, loaded again for each case. */
const readers = [
  file,
  nativeSpec,
  require.resolve('../platform/pushDevice.native'),
  require.resolve('../platform/sessionStore.native'),
  require.resolve('../chat/keyStore.native'),
  require.resolve('../chat/NativeChatCrypto'),
  require.resolve('../../common/chatCrypto/core.native')
]

interface Shown {
  title: string
  body: string
  url: string
  tag: string
  channel: string
  seq: number
}

/** `TSPush` as the task sees it, recording what it posts. */
function pushModule(): {
  shown: Shown[]
  show: (...args: [string, string, string, string, string, number]) => void
  environment: () => Promise<string>
} {
  const shown: Shown[] = []
  return {
    shown,
    show: (title, body, url, tag, channel, seq) => {
      shown.push({ title, body, url, tag, channel, seq })
    },
    environment: async () => 'production'
  }
}

/**
 * The task module, over stand-ins: `TSPush` is `push`, the session `token`,
 * and `user` the id of who the app keeps as signed in.
 */
function load(
  push: object | undefined,
  token: string | null = 'session-token',
  user: string | null = null
): typeof TaskModule {
  for (const path of readers) Reflect.deleteProperty(require.cache, path)
  stand('react-native', {
    Platform: { OS: 'android' },
    TurboModuleRegistry: {
      get: (name: string) => (name === 'TSPush' ? push : null)
    }
  })
  stand('react-native-keychain', {
    ACCESSIBLE: {
      AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
        'AccessibleAfterFirstUnlockThisDeviceOnly'
    },
    getGenericPassword: async () => false,
    hasGenericPassword: async () => false,
    setGenericPassword: async () => true,
    resetGenericPassword: async () => true
  })
  stand('@react-native-async-storage/async-storage', {
    __esModule: true,
    default: {
      getItem: async (key: string) =>
        key === 'ts.session.token'
          ? token
          : key === 'ts.session.user' && user != null
            ? JSON.stringify({
                id: user,
                displayName: 'Phone Owner',
                isAdmin: false
              })
            : null
    }
  })
  return require('./chatWakeTask.native') as typeof TaskModule
}

const cases = wakeCases()
const named = (name: string): WakeCase => {
  const found = cases.find(item => item.name === name)
  if (found == null) throw new Error(`No wake case ${name}`)
  return found
}

/** A new token the `PushToken` task handed the device, and for whom. */
interface Handed {
  userId: string | undefined
  address: string
  client: PushClient
}

/** The tokens the deps' API client was made with, in order. */
type Tokens = Array<string | undefined>

/** Deps that open `item` as its case says, with the tokens handed over. */
function depsFor(
  item: WakeCase,
  push: ReturnType<typeof pushModule> | null,
  handed: Handed[] = [],
  tokens: Tokens = []
): TaskModule.TaskDeps {
  const opened = depsOf(item)
  const client: Awaited<ReturnType<TaskModule.TaskDeps['client']>> = {
    chatMessages: async (conversationId, page) =>
      [
        await opened.fetchMessage(conversationId, (page?.after ?? 0) + 1)
      ].filter(message => message != null),
    chatEpochs: async (conversationId, after) =>
      await opened.fetchEpochs(conversationId, after ?? 0),
    chatIdentity: async identityId => await opened.fetchIdentity(identityId),
    webPushKey: async () => null,
    registerPush: async () => 'reg-1',
    updatePush: async () => ({ messages: false, rsvpEvents: false })
  }
  return {
    loadToken: async () => 'session-token',
    // The person the wake is for is the one signed in here.
    loadUser: async () => ({ id: item.wake.u }),
    loadRecord: async userId =>
      item.record?.userId === userId ? item.record : undefined,
    client: async token => {
      tokens.push(token)
      return client
    },
    // The phone's device, which posts in its own turn.
    device: () => ({
      tokenChanged: async (to, userId, address) => {
        handed.push({ userId, address, client: to })
      }
    }),
    loadCore: async () => undefined,
    push: () => push
  }
}

describe('the Android push tasks', function () {
  afterEach(function () {
    for (const path of [
      ...readers,
      ...standIns.map(name => require.resolve(name))
    ])
      Reflect.deleteProperty(require.cache, path)
  })

  it('shows a DM and a mention, opened on the phone, on the Messages channel', async function () {
    const { runChatWake } = load(undefined)
    for (const name of ['dm', 'mention', 'fetched']) {
      const item = named(name)
      const push = pushModule()
      await runChatWake(
        { payload: JSON.stringify(item.wake) },
        depsFor(item, push)
      )
      expect(push.shown).deep.equals([
        { ...item.expected, channel: 'messages', seq: item.wake.seq }
      ])
    }
  })

  it('shows nothing for another message, a reaction, or a wake it cannot read', async function () {
    const { runChatWake } = load(undefined)
    for (const name of ['groupPlain', 'reaction', 'edit', 'delete']) {
      const push = pushModule()
      const item = named(name)
      await runChatWake(
        { payload: JSON.stringify(item.wake) },
        depsFor(item, push)
      )
      expect(push.shown, name).deep.equals([])
    }
    const push = pushModule()
    for (const payload of [undefined, 'not json', '{"t":"event"}'])
      await runChatWake({ payload }, depsFor(named('dm'), push))
    expect(push.shown).deep.equals([])
  })

  it('says who wrote a DM without keys for it, and nothing for a group', async function () {
    const { runChatWake } = load(undefined)
    const push = pushModule()
    const dm = named('dm')
    await runChatWake(
      { payload: JSON.stringify(dm.wake) },
      {
        ...depsFor(dm, push),
        loadRecord: async () => {
          throw new Error('locked')
        }
      }
    )
    expect(push.shown).deep.equals([
      {
        title: dm.wake.from,
        body: `New message from ${dm.wake.from}`,
        url: dm.wake.url,
        tag: `chat:${dm.wake.c}`,
        channel: 'messages',
        seq: dm.wake.seq
      }
    ])
    const group = named('mention')
    const nothing = pushModule()
    await runChatWake(
      { payload: JSON.stringify(group.wake) },
      { ...depsFor(group, nothing), loadRecord: async () => undefined }
    )
    expect(nothing.shown).deep.equals([])
  })

  it('shows a DM to the person signed in when the app keeps no token, over the session cookie', async function () {
    // A refused request drops the stored token, and the app stays signed in
    // on the cookie the API set; the wake opens the same way.
    const { runChatWake, runPushToken } = load(undefined)
    const dm = named('dm')
    const push = pushModule()
    const handed: Handed[] = []
    const tokens: Tokens = []
    const cookieOnly = {
      ...depsFor(dm, push, handed, tokens),
      loadToken: async () => undefined
    }
    await runChatWake({ payload: JSON.stringify(dm.wake) }, cookieOnly)
    expect(push.shown).deep.equals([
      { ...dm.expected, channel: 'messages', seq: dm.wake.seq }
    ])
    await runPushToken({ token: 'fcm-1' }, cookieOnly)
    expect(handed.map(item => [item.address, item.userId])).deep.equals([
      ['fcm-1', dm.wake.u]
    ])
    expect(tokens).deep.equals([undefined, undefined])
  })

  it('shows nothing, not even who wrote, for a wake for anybody but the person signed in', async function () {
    const { runChatWake } = load(undefined)
    for (const name of ['dm', 'mention']) {
      const item = named(name)
      const push = pushModule()
      const tokens: Tokens = []
      for (const loadUser of [
        async () => ({ id: 'usr_someoneElse' }),
        async () => {
          throw new Error('unreadable')
        }
      ])
        await runChatWake(
          { payload: JSON.stringify(item.wake) },
          { ...depsFor(item, push, [], tokens), loadUser }
        )
      expect(push.shown, name).deep.equals([])
      // Nothing is asked of the API for somebody else.
      expect(tokens, name).deep.equals([])
    }
  })

  it('does nothing signed out, or in a build without TSPush', async function () {
    const { runChatWake, runPushToken } = load(undefined)
    const dm = named('dm')
    const push = pushModule()
    const handed: Handed[] = []
    const signedOut = {
      ...depsFor(dm, push, handed),
      loadUser: async () => undefined
    }
    await runChatWake({ payload: JSON.stringify(dm.wake) }, signedOut)
    await runPushToken({ token: 'fcm-1' }, signedOut)
    await runChatWake(
      { payload: JSON.stringify(dm.wake) },
      depsFor(dm, null, handed)
    )
    await runPushToken({ token: 'fcm-1' }, depsFor(dm, null, handed))
    expect(push.shown).deep.equals([])
    expect(handed).deep.equals([])
  })

  it('hands a new token to the device, for the session and the person signed in, and survives a refusal', async function () {
    const { runPushToken } = load(undefined)
    const handed: Handed[] = []
    const deps = depsFor(named('dm'), pushModule(), handed)
    await runPushToken({ token: 'debug-1' }, deps)
    await runPushToken({ token: 3 }, deps)
    expect(handed).deep.equals([
      {
        userId: named('dm').wake.u,
        address: 'debug-1',
        client: await deps.client('x')
      }
    ])
    // Not knowing who is signed in, it posts nothing.
    handed.length = 0
    await runPushToken(
      { token: 'debug-4' },
      {
        ...deps,
        loadUser: async () => {
          throw new Error('unreadable')
        }
      }
    )
    expect(handed).deep.equals([])
    await runPushToken(
      { token: 'debug-2' },
      {
        ...deps,
        device: () => ({
          tokenChanged: async () => {
            throw new Error('offline')
          }
        })
      }
    )
  })

  it('registers both tasks, run with the phone’s own deps', async function () {
    const push = pushModule()
    const dm = named('dm')
    const { registerPushTasks, phoneDeps } = load(
      push,
      'session-token',
      dm.wake.u
    )
    const tasks = new Map<string, (data: object) => Promise<void>>()
    const registry: TaskModule.TaskRegistry = {
      registerHeadlessTask: (name, task) => {
        tasks.set(name, task())
      }
    }
    registerPushTasks(registry)
    expect([...tasks.keys()]).deep.equals(['ChatWake', 'PushToken'])
    // The phone's: its session, an empty key store and no chat core here,
    // so a DM says who wrote; a token is posted to the API.
    const deps = phoneDeps()
    expect(await deps.loadToken()).equals('session-token')
    // Who is stored; a new token goes through the app's own device.
    expect((await deps.loadUser())?.id).equals(dm.wake.u)
    expect(deps.device()).equals(
      (require('../platform/pushDevice.native') as { pushDevice: unknown })
        .pushDevice
    )
    expect(await deps.loadRecord('usr_x')).equals(undefined)
    expect(await deps.loadCore()).deep.equals({
      ready: false,
      reason: 'noNativeModule'
    })
    expect(deps.push()).equals(push)
    // On the API this launch talks to: a stable build's own.
    const phone = (await deps.client('t')) as TeamStationClient
    expect(typeof phone.registerPush).equals('function')
    expect(phone.baseUrl).equals(
      (require('../native/config') as { apiBaseUrl: string }).apiBaseUrl
    )
    expect(phone.token).equals('t')
    // A develop build pointed at another server calls that one, the API
    // the token was kept for, not the built one.
    const pointed = (await phoneDeps(
      async () => 'https://stack.example.test/api/v1'
    ).client('t')) as TeamStationClient
    expect(pointed.baseUrl).equals('https://stack.example.test/api/v1')
    await tasks.get('ChatWake')!({ payload: JSON.stringify(dm.wake) })
    expect(push.shown.map(note => note.body)).deep.equals([
      `New message from ${dm.wake.from}`
    ])
    // Signed out, a token is not posted anywhere.
    const signedOut = load(push, null, null)
    const quiet = new Map<string, (data: object) => Promise<void>>()
    signedOut.registerPushTasks({
      registerHeadlessTask: (name, task) => {
        quiet.set(name, task())
      }
    })
    await quiet.get('PushToken')!({ token: 'debug-1' })
    expect(load(undefined).phoneDeps().push()).equals(null)
    expect((require('./NativePush') as { default: unknown }).default).equals(
      undefined
    )
  })
})
