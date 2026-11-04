import { expect } from 'chai'
import type { Request, RequestHandler, Response } from 'express'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { newIdentityId } from '../../common/chatCrypto/messageIds'
import { userIdOfGumbo } from '../../common/userId'
import type * as Epochs from '../chat/epochs'
import type * as History from '../chat/historyRecovery'
import type * as Requests from '../chat/historyRequests'
import type * as Membership from '../chat/reconciler'
import type { Database } from '../db/database'
import { chatEpochRoutes } from './chatEpochs'

const epochs = require('../chat/epochs') as typeof Epochs
const history = require('../chat/historyRecovery') as typeof History
const requests = require('../chat/historyRequests') as typeof Requests
const membership = require('../chat/reconciler') as typeof Membership

/** The router is invoked directly; no listener, database, or network is used. */
describe('chat history route dispatch and audit boundaries', () => {
  const saved = {
    epochs: { ...epochs },
    history: { ...history },
    requests: { ...requests },
    membership: { ...membership }
  }
  const calls: Array<{ name: string; args: unknown[] }> = []
  const now = new Date('2026-10-01T00:00:00Z')
  const userId = userIdOfGumbo(1)
  let isMember = true
  let enabled = true
  let transactionMember = true
  const db = {
    transaction: () => ({
      execute: async (run: (trx: unknown) => Promise<unknown>) => await run(db)
    }),
    selectFrom: () => {
      const query = {
        select: () => query,
        where: () => query,
        executeTakeFirst: async () =>
          transactionMember ? { user_id: userId } : undefined
      }
      return query
    }
  } as unknown as Kysely<Database>
  const record = (name: string, args: unknown[]): void => {
    calls.push({ name, args })
  }
  beforeEach(() => {
    calls.length = 0
    isMember = true
    enabled = true
    transactionMember = true
    membership.memberNow = async (...args) => {
      record('member', args)
      return isMember
    }
    epochs.lockConversation = async (...args) => {
      record('lock', args)
      return {
        id: 'chat',
        kind: 'dm',
        scope_id: null,
        closed_at: null,
        needs_rotation: false
      }
    }
    epochs.epochsFor = async (...args) => {
      record('epochs', args)
      return {
        latest: 2,
        needsRotation: false,
        noHolder: false,
        epochs: [],
        boxes: []
      }
    }
    epochs.createEpoch = async (...args) => {
      record('create', args)
      return { epoch: 3, chainBreak: true, boxed: 1, grantRequests: 0 }
    }
    epochs.grantsFor = async (...args) => {
      record('legacy-list', args)
      return []
    }
    epochs.postGrants = async (...args) => {
      record('legacy-post', args)
      return { filled: 0, skipped: [] }
    }
    history.historyGrantsFor = async (...args) => {
      record('history-list', args)
      return { requests: [], nextCursor: null }
    }
    history.postHistoryGrants = async (...args) => {
      record('history-post', args)
      return { filled: 1, results: [] }
    }
    history.reconcileUnreconciled = async (...args) => {
      record('reconcile-once', args)
    }
    requests.reconcileHistoryRequests = async (...args) => {
      record('reconcile', args)
    }
  })
  afterEach(() => {
    Object.assign(epochs, saved.epochs)
    Object.assign(history, saved.history)
    Object.assign(requests, saved.requests)
    Object.assign(membership, saved.membership)
  })
  async function call(
    method: string,
    path: string,
    query: Record<string, string> = {},
    body?: unknown
  ): Promise<{
    result: unknown
    status: number
    locals: Record<string, unknown>
  }> {
    const router = chatEpochRoutes(db, () => now, {
      freshEpochsEnabled: () => enabled
    })
    const layers = router.stack as unknown as Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: RequestHandler }>
      }
    }>
    const layer = layers.find(
      layer => layer.route?.path === path && layer.route.methods[method]
    )
    const handler = layer?.route?.stack.at(-1)?.handle
    if (handler == null) throw new Error('Expected route handler')
    const locals = {}
    let status = 200
    const result = await new Promise<unknown>((resolve, reject) => {
      const req = {
        actor: { userId, sessionId: 'session' },
        params: { conversationId: 'chat' },
        query,
        body
      } as unknown as Request
      const res = {
        locals,
        status: (value: number) => {
          status = value
          return res
        },
        json: resolve
      } as unknown as Response
      handler(req, res, reject)
    })
    return { result, status, locals }
  }
  const epochPath = '/chat/conversations/:conversationId/epochs'
  it('keeps legacy reads separate from transactional delivery and advertises support with the feature off', async () => {
    enabled = false
    expect((await call('get', epochPath)).result).include({
      historyRecoveryVersion: 1,
      freshEpochsEnabled: false
    })
    expect(calls.map(c => c.name)).deep.equals(['member', 'epochs'])
    calls.length = 0
    await call('get', epochPath, {
      after: '3',
      boxesAfter: '9007199254740993',
      boxLimit: '1'
    })
    expect(calls.map(c => c.name)).deep.equals([
      'member',
      'reconcile-once',
      'epochs'
    ])
    expect(calls[1].args.slice(1)).deep.equals([['chat'], now])
    expect(calls.at(-1)!.args.slice(3)).deep.equals([
      3,
      { boxesAfter: '9007199254740993', boxLimit: 1 }
    ])
    transactionMember = false
    try {
      await call('get', epochPath, { boxesAfter: '0' })
      expect.fail('removed member')
    } catch (error) {
      expect((error as { status: number }).status).equals(404)
    }
  })
  it('dispatches scoped lists without changing the default list shape', async () => {
    expect((await call('get', '/chat/grants')).result).deep.equals([])
    await call('get', '/chat/grants', {
      scope: 'history',
      cursor: '9007199254740993',
      limit: '1'
    })
    expect(calls.map(c => c.name)).deep.equals(['legacy-list', 'history-list'])
    expect(calls[1].args.slice(2)).deep.equals(['9007199254740993', 1, now])
  })
  it('audits metadata only and rejects pagination on history writes', async () => {
    const box = {
      requestId: '1',
      conversationId: 'chat',
      targetEpoch: 2,
      epoch: 1,
      userId,
      identityId: newIdentityId(),
      pukGeneration: 1,
      box: Buffer.alloc(80).toString('base64url'),
      approveHistory: true
    }
    const result = await call(
      'post',
      '/chat/grants',
      { scope: 'history' },
      { boxes: [box] }
    )
    expect(calls.map(c => c.name)).deep.equals(['member', 'history-post'])
    expect(result.locals).deep.equals({
      audit: {
        entityType: 'chatHistoryGrant',
        entityId: userId,
        after: { filled: 1, processed: 0 }
      }
    })
    expect(JSON.stringify(result.locals)).not.contains(box.box)
    try {
      await call(
        'post',
        '/chat/grants',
        { scope: 'history', cursor: '0' },
        { boxes: [box] }
      )
      expect.fail('write cursor')
    } catch (error) {
      expect((error as { status: number }).status).equals(400)
    }
    isMember = false
    try {
      await call('post', '/chat/grants', { scope: 'history' }, { boxes: [box] })
      expect.fail('nonmember')
    } catch (error) {
      expect((error as { status: number }).status).equals(404)
    }
  })
  it('passes the live publication switch and preserves the legacy grant route', async () => {
    const result = await call(
      'post',
      epochPath,
      {},
      {
        mode: 'fresh',
        epoch: 3,
        previousKeyBox: null,
        signature: Buffer.alloc(64).toString('base64url'),
        boxes: []
      }
    )
    expect(result.status).equals(201)
    expect(calls.find(c => c.name === 'create')!.args.at(-1)).equals(true)
    await call(
      'post',
      '/chat/grants',
      {},
      {
        boxes: [
          {
            conversationId: 'chat',
            epoch: 3,
            userId,
            identityId: newIdentityId(),
            pukGeneration: 1,
            box: Buffer.alloc(80).toString('base64url')
          }
        ]
      }
    )
    expect(calls.at(-1)!.name).equals('legacy-post')
  })
})
