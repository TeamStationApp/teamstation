import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'
import WebSocket from 'ws'

import { asAccountNotifications } from '../../common/accountSettings'
import type { GameSocketReply } from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { databaseUrlOf } from '../../test/screenScopeNotices'
import { createSession } from '../auth/sessions'
import { hashToken } from '../auth/tokens'
import { attachGameSocket, type GameSocketHandle } from '../socket/gameSocket'

const ROUTE = '/me/account/notifications'

/** A socket signed in with `token`, keeping every frame it is sent. */
interface Listener {
  ws: WebSocket
  frames: GameSocketReply[]
}

describe('the account notification switches', function () {
  this.timeout(60000)
  let h: AccountHarness
  let socket: GameSocketHandle
  let url = ''
  const opened: Listener[] = []

  before(async () => {
    h = await accountHarness()
    socket = attachGameSocket(h.server, h.db, await databaseUrlOf(h.db), {
      stopSignals: null,
      log: () => undefined,
      chat: { log: () => undefined }
    })
    await socket.chat.listening
    url = h.origin.replace('http://', 'ws://') + '/socket'
  })
  beforeEach(async () => {
    await h.resetLimits()
    await h.db.deleteFrom('user_notification_settings').execute()
  })
  after(async () => {
    for (const listener of opened) listener.ws.close()
    await socket?.close()
    await h?.close()
  })

  const listen = async (token: string): Promise<Listener> => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` }
    })
    const frames: GameSocketReply[] = []
    ws.on('message', data => {
      frames.push(JSON.parse((data as Buffer).toString('utf8')))
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    const listener = { ws, frames }
    opened.push(listener)
    return listener
  }
  const heard = (listener: Listener): GameSocketReply[] =>
    listener.frames.filter(frame => frame.type === 'chatUser')
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Nothing was heard')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const read = async (user: number | string = 101): Promise<unknown> => {
    const response = await h.request('GET', ROUTE, undefined, user)
    expect(response.status).equals(200)
    return asAccountNotifications(await response.json())
  }
  const save = async (
    body: unknown,
    user: number | string | null = 101
  ): Promise<Response> => await h.request('PUT', ROUTE, body, user)

  it('starts with both off, on the account and on its own', async () => {
    expect(await read()).deep.equals({ messages: false, rsvpEvents: false })
    const account = await h.request('GET', '/me/account')
    expect(
      ((await account.json()) as { notifications: unknown }).notifications
    ).deep.equals({ messages: false, rsvpEvents: false })
  })

  it('changes only the switch it is given, and keeps it for the account', async () => {
    const first = await save({ messages: true })
    expect(first.status).equals(200)
    expect(await first.json()).deep.equals({
      messages: true,
      rsvpEvents: false
    })
    expect(await (await save({ rsvpEvents: true })).json()).deep.equals({
      messages: true,
      rsvpEvents: true
    })
    expect(await (await save({ messages: false })).json()).deep.equals({
      messages: false,
      rsvpEvents: true
    })
    // Nothing to change answers what is kept.
    expect(await (await save({})).json()).deep.equals({
      messages: false,
      rsvpEvents: true
    })
    const account = await h.request('GET', '/me/account')
    expect(
      ((await account.json()) as { notifications: unknown }).notifications
    ).deep.equals({ messages: false, rsvpEvents: true })
    // Another account is untouched.
    expect(await read(102)).deep.equals({ messages: false, rsvpEvents: false })
  })

  it('refuses a switch that is not on or off, and stores nothing', async () => {
    for (const body of [{ messages: 'yes' }, { rsvpEvents: 1 }, 'on'])
      expect((await save(body)).status, JSON.stringify(body)).equals(400)
    expect(await read()).deep.equals({ messages: false, rsvpEvents: false })
  })

  it('is for a signed-in person, never an API key', async () => {
    expect((await h.request('GET', ROUTE, undefined, null)).status).equals(401)
    expect((await save({ messages: true }, null)).status).equals(401)
    await h.db
      .insertInto('user_api_keys')
      .values({
        id: makeId('userApiKey'),
        user_id: userIdOfGumbo(101),
        name: 'Notifications key',
        token_hash: hashToken('tsk_notifications_account'),
        secret_sealed: 'v1.unused',
        permissions: ['account:read', 'account:write']
      })
      .execute()
    expect(
      (await h.request('GET', ROUTE, undefined, 'tsk_notifications_account'))
        .status
    ).equals(403)
    expect(
      (await save({ messages: true }, 'tsk_notifications_account')).status
    ).equals(403)
    expect(await read()).deep.equals({ messages: false, rsvpEvents: false })
  })

  it('tells the person’s other devices at once, and nobody else', async () => {
    const other = await createSession(
      h.db,
      userIdOfGumbo(101),
      'notifications-test'
    )
    const here = await listen(h.tokens.get(101)!)
    const there = await listen(other.token)
    const someoneElse = await listen(h.tokens.get(102)!)
    expect((await save({ rsvpEvents: true })).status).equals(200)
    await until(() => heard(there).length > 0 && heard(here).length > 0)
    expect(heard(there)).deep.equals([
      { type: 'chatUser', kind: 'notifications' }
    ])
    expect(heard(here)).deep.equals([
      { type: 'chatUser', kind: 'notifications' }
    ])
    // The other device reads what changed.
    expect(await read(other.token)).deep.equals({
      messages: false,
      rsvpEvents: true
    })
    expect(heard(someoneElse)).deep.equals([])
  })
})
