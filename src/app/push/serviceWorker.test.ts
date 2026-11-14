import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { ChatMessage } from '../../common/api'
import type { EventReminder } from '../../common/push'
import { type WakeCase, wakeCases } from '../../test/chatWakeCases'
import {
  browserDeps,
  installWorker,
  notificationOf as notificationOfPayload,
  openLink,
  pathOfLink,
  payloadOf,
  type WindowClient,
  type WorkerClients,
  type WorkerDeps,
  type WorkerScope
} from '../web/sw'

/**
 * The web app's service worker (`src/app/web/sw.ts`), on the real chat
 * crypto: the chat wakes are `chatWakeCases.ts`'s, sent as the server sends
 * them, and the browser around the worker is this test's.
 */

/** What a push's text shows, as the worker reads it. */
const notificationOf = async (
  data: string | null,
  deps: WorkerDeps
): ReturnType<typeof notificationOfPayload> =>
  await notificationOfPayload(payloadOf(data), deps)

const cases = wakeCases()
const named = (name: string): WakeCase => {
  const found = cases.find(item => item.name === name)
  if (found == null) throw new Error(`No wake case ${name}`)
  return found
}

/** What this browser would answer for a case, and what was asked of it. */
function depsOf(
  item: WakeCase,
  calls: string[] = [],
  signedIn: () => Promise<string | null> = async () => item.wake.u
): WorkerDeps & { calls: string[] } {
  return {
    calls,
    signedIn,
    loadRecord: async userId => {
      calls.push(`record ${userId}`)
      return item.record
    },
    loadCore: async () => {
      calls.push('core')
    },
    client: {
      chatMessages: async (conversationId, page = {}) => {
        calls.push(
          `messages ${conversationId} after ${page.after} limit ${page.limit}`
        )
        const message: ChatMessage | undefined = item.message
        return message?.seq === (page.after ?? 0) + 1 ? [message] : []
      },
      chatEpochs: async conversationId => {
        calls.push(`epochs ${conversationId}`)
        return item.epochs
      },
      chatIdentity: async identityId => {
        const identity = item.identities.find(held => held.id === identityId)
        if (identity == null) throw new Error('No such identity')
        return identity
      }
    }
  }
}

const REMINDER: EventReminder = {
  t: 'event',
  u: named('dm').wake.u,
  title: 'Eagles vs Owls',
  body: 'Starts at 5:30 PM',
  url: 'teamstation://games/gam_1',
  tag: 'event:gam_1'
}

/** A window of the app, as `clients.matchAll` answers it. */
function window(
  options: {
    focus?: Error
    navigate?: Error
    url?: string
    focused?: boolean
    visibilityState?: WindowClient['visibilityState']
  } = {}
): WindowClient & { went: string[]; focusedTimes: number } {
  const client = {
    went: [] as string[],
    focusedTimes: 0,
    url: options.url ?? 'https://app.example.com/',
    focused: options.focused ?? false,
    visibilityState: options.visibilityState ?? 'hidden',
    focus: async (): Promise<WindowClient> => {
      client.focusedTimes++
      if (options.focus != null) throw options.focus
      return client
    },
    navigate: async (url: string): Promise<WindowClient> => {
      if (options.navigate != null) throw options.navigate
      client.went.push(url)
      return client
    }
  }
  return client
}

function clientsOf(
  open: WindowClient[]
): WorkerClients & { opened: string[]; claimed: number } {
  const clients = {
    opened: [] as string[],
    claimed: 0,
    claim: async () => {
      clients.claimed++
    },
    matchAll: async (options: {
      type: 'window'
      includeUncontrolled: boolean
    }) => {
      expect(options).deep.equals({ type: 'window', includeUncontrolled: true })
      return open
    },
    openWindow: async (url: string) => {
      clients.opened.push(url)
      return undefined
    }
  }
  return clients
}

const CHROME = 'https://fcm.googleapis.com/fcm/send/aAAAAAAAAAA:APA91b0000'

/**
 * A worker's scope, its handlers kept by event name, and what it showed,
 * subscribed at `endpoint`.
 */
function scopeOf(
  clients = clientsOf([]),
  endpoint: string | null = CHROME
): WorkerScope & {
  handlers: Map<string, (event: unknown) => void>
  shown: Array<{ title: string; options: unknown }>
  skipped: number
  clients: ReturnType<typeof clientsOf>
} {
  const scope = {
    handlers: new Map<string, (event: unknown) => void>(),
    shown: [] as Array<{ title: string; options: unknown }>,
    skipped: 0,
    clients,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      scope.handlers.set(type, listener)
    },
    skipWaiting: async () => {
      scope.skipped++
    },
    registration: {
      showNotification: async (title: string, options: { tag: string }) => {
        scope.shown.push({ title, options })
      },
      // What it shows stays until a read closes it, as a browser's does.
      getNotifications: async (filter: { tag: string }) =>
        scope.shown
          .filter(
            shown => (shown.options as { tag: string }).tag === filter.tag
          )
          .map(shown => ({
            data: (shown.options as { data?: unknown }).data,
            close: () => {
              scope.shown.splice(scope.shown.indexOf(shown), 1)
            }
          })),
      pushManager: {
        getSubscription: async () => (endpoint == null ? null : { endpoint })
      }
    }
  }
  return scope as unknown as ReturnType<typeof scopeOf>
}

/** Fires `type` at the scope and waits for what it handed `waitUntil`. */
async function fire(
  scope: ReturnType<typeof scopeOf>,
  type: string,
  event: object
): Promise<void> {
  const work: Array<Promise<unknown>> = []
  scope.handlers.get(type)!({
    ...event,
    waitUntil: (promise: Promise<unknown>) => {
      work.push(promise)
    }
  })
  await Promise.all(work)
}

const pushed = (payload: unknown): { data: { text: () => string } } => ({
  data: { text: () => JSON.stringify(payload) }
})

describe('the web app’s service worker', function () {
  it('shows a DM and a mention opened with this browser’s keys, and nothing for another message', async function () {
    const dm = named('dm')
    expect(
      await notificationOf(JSON.stringify(dm.wake), depsOf(dm))
    ).deep.equals(dm.expected)
    const mention = named('mention')
    const calls: string[] = []
    expect(
      await notificationOf(JSON.stringify(mention.wake), depsOf(mention, calls))
    ).deep.equals(mention.expected)
    // The record for the person the wake is for, and the core, first.
    expect(calls.slice(0, 2)).deep.equals([`record ${mention.wake.u}`, 'core'])
    const plain = named('groupPlain')
    expect(
      await notificationOf(JSON.stringify(plain.wake), depsOf(plain))
    ).equals(null)
    for (const name of ['reaction', 'edit', 'delete', 'groupBadSignature'])
      expect(
        await notificationOf(
          JSON.stringify(named(name).wake),
          depsOf(named(name))
        )
      ).equals(null)
  })

  it('fetches a message the wake did not carry', async function () {
    const fetched = named('fetched')
    const calls: string[] = []
    expect(
      await notificationOf(JSON.stringify(fetched.wake), depsOf(fetched, calls))
    ).deep.equals(fetched.expected)
    expect(calls).includes(
      `messages ${fetched.wake.c} after ${fetched.wake.seq - 1} limit 1`
    )
  })

  it('says who wrote a DM, and shows no group message, with no record for that person here', async function () {
    const dm = named('dmNoRecord')
    const calls: string[] = []
    expect(
      await notificationOf(JSON.stringify(dm.wake), depsOf(dm, calls))
    ).deep.equals(dm.expected)
    // No record, so no core to load.
    expect(calls).deep.equals([`record ${dm.wake.u}`])
    const group = named('groupNoRecord')
    expect(
      await notificationOf(JSON.stringify(group.wake), depsOf(group))
    ).equals(null)
    // A key store that cannot be read holds no record.
    const unreadable = depsOf(named('dm'))
    unreadable.loadRecord = async () => {
      throw new Error('No IndexedDB')
    }
    expect(
      await notificationOf(JSON.stringify(named('dm').wake), unreadable)
    ).deep.equals(dm.expected)
  })

  it('shows nothing for a person not signed in here, but goes on when the server cannot say', async function () {
    const dm = named('dmNoRecord')
    const nobody = async (): Promise<null> => null
    const somebodyElse = async (): Promise<string> => 'usr_somebody_else'
    for (const signedIn of [nobody, somebodyElse]) {
      const calls: string[] = []
      // Signed out, or another person signed in: no DM's sender, no
      // mention, no reminder, and the keys are not read.
      expect(
        await notificationOf(
          JSON.stringify(dm.wake),
          depsOf(dm, calls, signedIn)
        )
      ).equals(null)
      expect(
        await notificationOf(
          JSON.stringify(named('dm').wake),
          depsOf(named('dm'), calls, signedIn)
        )
      ).equals(null)
      expect(
        await notificationOf(
          JSON.stringify(REMINDER),
          depsOf(named('dm'), calls, signedIn)
        )
      ).equals(null)
      expect(calls).deep.equals([])
    }
    // The server away: shown as before.
    const away = async (): Promise<never> => {
      throw new Error('offline')
    }
    expect(
      await notificationOf(JSON.stringify(dm.wake), depsOf(dm, [], away))
    ).deep.equals(dm.expected)
    expect(
      await notificationOf(
        JSON.stringify(REMINDER),
        depsOf(named('dm'), [], away)
      )
    ).deep.equals({
      title: REMINDER.title,
      body: REMINDER.body,
      url: REMINDER.url,
      tag: REMINDER.tag
    })
  })

  it('still tries the message when the core will not load', async function () {
    const dm = named('dm')
    const deps = depsOf(dm)
    deps.loadCore = async () => {
      throw new Error('fetchFailed')
    }
    // Node's core is loaded already, so the message still opens here.
    expect(await notificationOf(JSON.stringify(dm.wake), deps)).deep.equals(
      dm.expected
    )
  })

  it('shows a reminder as it came, and nothing for what is not a push of ours', async function () {
    expect(
      await notificationOf(JSON.stringify(REMINDER), depsOf(named('dm')))
    ).deep.equals({
      title: 'Eagles vs Owls',
      body: 'Starts at 5:30 PM',
      url: 'teamstation://games/gam_1',
      tag: 'event:gam_1'
    })
    for (const data of [null, '', 'not json', '{"t":"other"}'])
      expect(await notificationOf(data, depsOf(named('dm')))).equals(null)
  })

  it('shows a push with its tag and link, and shows nothing it was not asked to', async function () {
    const scope = scopeOf()
    installWorker(scope, depsOf(named('dm')))
    await fire(scope, 'push', pushed(REMINDER))
    expect(scope.shown).deep.equals([
      {
        title: 'Eagles vs Owls',
        options: {
          body: 'Starts at 5:30 PM',
          tag: 'event:gam_1',
          data: { url: 'teamstation://games/gam_1' },
          icon: '/favicon.png'
        }
      }
    ])
    const plain = scopeOf()
    installWorker(plain, depsOf(named('groupPlain')))
    await fire(plain, 'push', pushed(named('groupPlain').wake))
    await fire(plain, 'push', { data: null })
    expect(plain.shown).deep.equals([])
  })

  it('shows no wake for the conversation a focused, visible window shows', async function () {
    const dm = named('dm')
    const path = `https://app.example.com/chat/${dm.wake.c}`
    const reading = scopeOf(
      clientsOf([
        window({ url: path, focused: true, visibilityState: 'visible' })
      ])
    )
    installWorker(reading, depsOf(dm))
    await fire(reading, 'push', pushed(dm.wake))
    expect(reading.shown).deep.equals([])
    // A reminder is shown whatever is on screen.
    await fire(reading, 'push', pushed(REMINDER))
    expect(reading.shown).lengthOf(1)
    // Not focused, hidden, or another page: it shows.
    for (const open of [
      window({ url: path, focused: false, visibilityState: 'visible' }),
      window({ url: path, focused: true, visibilityState: 'hidden' }),
      window({
        url: 'https://app.example.com/chat/cnv_other',
        focused: true,
        visibilityState: 'visible'
      }),
      window({
        url: `${path}/info`,
        focused: true,
        visibilityState: 'visible'
      })
    ]) {
      const scope = scopeOf(clientsOf([open]))
      installWorker(scope, depsOf(dm))
      await fire(scope, 'push', pushed(dm.wake))
      expect(scope.shown.map(shown => shown.title)).deep.equals([
        dm.expected!.title
      ])
    }
  })

  it('shows and takes down at once the wake on screen where a push that shows nothing would end the subscription', async function () {
    const dm = named('dm')
    const path = `https://app.example.com/chat/${dm.wake.c}`
    const onScreen = (): ReturnType<typeof clientsOf> =>
      clientsOf([
        window({ url: path, focused: true, visibilityState: 'visible' })
      ])
    for (const endpoint of [
      'https://web.push.apple.com/QGmHZGq0AAAAAAAAAAAAAAAAAAAAAAAA',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAAAAAAAAAAAAAAA'
    ]) {
      const scope = scopeOf(onScreen(), endpoint)
      const titles: string[] = []
      const show = scope.registration.showNotification
      scope.registration.showNotification = async (title, options) => {
        titles.push(title)
        await show(title, options)
      }
      installWorker(scope, depsOf(dm))
      await fire(scope, 'push', pushed(dm.wake))
      // Shown, so the push counts as one that showed something, and gone.
      expect(titles, endpoint).deep.equals([dm.expected!.title])
      expect(scope.shown, endpoint).deep.equals([])
      // Off screen, it stays.
      const away = scopeOf(clientsOf([]), endpoint)
      installWorker(away, depsOf(dm))
      await fire(away, 'push', pushed(dm.wake))
      expect(away.shown.map(shown => shown.title)).deep.equals([
        dm.expected!.title
      ])
    }
    // No subscription to tell by, or one that cannot be read: nothing shown.
    const unsubscribed = scopeOf(onScreen(), null)
    installWorker(unsubscribed, depsOf(dm))
    await fire(unsubscribed, 'push', pushed(dm.wake))
    expect(unsubscribed.shown).deep.equals([])
    const unreadable = scopeOf(onScreen())
    unreadable.registration.pushManager.getSubscription = async () => {
      throw new Error('no push manager')
    }
    installWorker(unreadable, depsOf(dm))
    await fire(unreadable, 'push', pushed(dm.wake))
    expect(unreadable.shown).deep.equals([])
  })

  it('closes a conversation’s notifications on a read, and shows nothing for it', async function () {
    const dm = named('dm')
    const scope = scopeOf()
    installWorker(scope, depsOf(dm))
    await fire(scope, 'push', pushed(dm.wake))
    await fire(scope, 'push', pushed(REMINDER))
    expect(scope.shown).lengthOf(2)
    // Another conversation's read leaves it.
    await fire(
      scope,
      'push',
      pushed({ t: 'read', u: dm.wake.u, c: 'cnv_other', seq: 9 })
    )
    expect(scope.shown).lengthOf(2)
    await fire(
      scope,
      'push',
      pushed({ t: 'read', u: dm.wake.u, c: dm.wake.c, seq: dm.wake.seq })
    )
    expect(scope.shown.map(shown => shown.title)).deep.equals([REMINDER.title])
    expect(
      await notificationOf(
        JSON.stringify({ t: 'read', u: 'usr_1', c: 'cnv_1', seq: 1 }),
        depsOf(dm)
      )
    ).equals(null)
  })

  it('keeps a wake’s seq, and takes down on a read only what was at or before it', async function () {
    const dm = named('dm')
    const scope = scopeOf()
    installWorker(scope, depsOf(dm))
    await fire(scope, 'push', pushed(dm.wake))
    expect(scope.shown.map(shown => shown.options)).deep.equals([
      {
        body: dm.expected!.body,
        tag: `chat:${dm.wake.c}`,
        data: { url: dm.wake.url, seq: dm.wake.seq },
        icon: '/favicon.png'
      }
    ])
    // A read of an earlier message, held back behind the wake, leaves it.
    await fire(
      scope,
      'push',
      pushed({ t: 'read', u: dm.wake.u, c: dm.wake.c, seq: dm.wake.seq - 1 })
    )
    expect(scope.shown).lengthOf(1)
    // One at it, or past it, takes it down.
    await fire(
      scope,
      'push',
      pushed({ t: 'read', u: dm.wake.u, c: dm.wake.c, seq: dm.wake.seq })
    )
    expect(scope.shown).deep.equals([])
    await fire(scope, 'push', pushed(dm.wake))
    await fire(
      scope,
      'push',
      pushed({ t: 'read', u: dm.wake.u, c: dm.wake.c, seq: dm.wake.seq + 5 })
    )
    expect(scope.shown).deep.equals([])
    // A notification that kept no seq goes on any read of its chat.
    await scope.registration.showNotification('Older', {
      body: 'From before seqs were kept',
      tag: `chat:${dm.wake.c}`,
      data: { url: dm.wake.url },
      icon: '/favicon.png'
    })
    await fire(
      scope,
      'push',
      pushed({ t: 'read', u: dm.wake.u, c: dm.wake.c, seq: 1 })
    )
    expect(scope.shown).deep.equals([])
  })

  it('takes over at once when installed', async function () {
    const scope = scopeOf()
    installWorker(scope, depsOf(named('dm')))
    await fire(scope, 'install', {})
    expect(scope.skipped).equals(1)
    await fire(scope, 'activate', {})
    expect(scope.clients.claimed).equals(1)
  })

  it('brings the open window to the tapped notification’s page, or opens one', async function () {
    const open = window()
    const scope = scopeOf(clientsOf([open]))
    installWorker(scope, depsOf(named('dm')))
    let closed = 0
    await fire(scope, 'notificationclick', {
      notification: {
        data: { url: 'teamstation://chat/cnv_wakeDm' },
        close: () => {
          closed++
        }
      }
    })
    expect(closed).equals(1)
    expect(open.focusedTimes).equals(1)
    expect(open.went).deep.equals(['/chat/cnv_wakeDm'])
    // A notification with no link only closes.
    await fire(scope, 'notificationclick', {
      notification: { close: () => closed++ }
    })
    expect(closed).equals(2)
    expect(open.went).lengthOf(1)

    const none = clientsOf([])
    await openLink(none, 'teamstation://games/gam_1')
    expect(none.opened).deep.equals(['/games/gam_1'])
  })

  it('moves a window it may not focus, and opens one it may not move', async function () {
    const unfocused = window({ focus: new Error('Not allowed to focus') })
    await openLink(clientsOf([unfocused]), 'teamstation://games/gam_1')
    expect(unfocused.went).deep.equals(['/games/gam_1'])
    const uncontrolled = window({ navigate: new TypeError('Not controlled') })
    const clients = clientsOf([uncontrolled])
    await openLink(clients, 'teamstation://chat/cnv_1')
    expect(clients.opened).deep.equals(['/chat/cnv_1'])
  })

  it('reads the page out of a notification’s link', function () {
    expect(pathOfLink('teamstation://chat/cnv_1')).equals('/chat/cnv_1')
    expect(pathOfLink('teamstation://games/gam_1?t=30')).equals(
      '/games/gam_1?t=30'
    )
    expect(pathOfLink('https://app.example.com/games/gam_1?t=30')).equals(
      '/games/gam_1?t=30'
    )
    expect(pathOfLink('/chat/cnv_2')).equals('/chat/cnv_2')
  })

  describe('in a browser', function () {
    const keys = ['ServiceWorkerGlobalScope', 'addEventListener'] as const
    afterEach(function () {
      for (const key of keys) Reflect.deleteProperty(globalThis, key)
    })

    it('reads the API at the bundle’s address, and keys from IndexedDB', async function () {
      const deps = browserDeps()
      expect((deps.client as unknown as { baseUrl: string }).baseUrl).equals(
        '/api/v1'
      )
      expect(
        (
          browserDeps('https://app.example.com/api/v1/').client as unknown as {
            baseUrl: string
          }
        ).baseUrl
      ).equals('https://app.example.com/api/v1')
      // Node has no IndexedDB, which a browser's worker reads.
      let failed = false
      await deps.loadRecord('usr_1').catch(() => {
        failed = true
      })
      expect(failed).equals(true)
      expect(await deps.loadCore()).deep.equals({ ready: true })
      // Node has no server to ask who is signed in.
      let asked = false
      await deps.signedIn().catch(() => {
        asked = true
      })
      expect(asked).equals(true)
    })

    it('installs its handlers only when it is a service worker', function () {
      const file = require.resolve('../web/sw')
      const types: string[] = []
      Reflect.deleteProperty(require.cache, file)
      require('../web/sw')
      Object.assign(globalThis, {
        ServiceWorkerGlobalScope: function ServiceWorkerGlobalScope() {},
        addEventListener: (type: string) => {
          types.push(type)
        }
      })
      expect(types).deep.equals([])
      Reflect.deleteProperty(require.cache, file)
      require('../web/sw')
      expect(types).deep.equals([
        'install',
        'activate',
        'push',
        'notificationclick'
      ])
      Reflect.deleteProperty(require.cache, file)
    })
  })
})
