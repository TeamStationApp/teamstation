import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  CHAT_DEVICE_APPROVAL,
  RECORDING_UPLOAD
} from '../../common/notifications'
import { withQueryReplies } from '../../test/queryReplies'
import type { StoredRequest } from '../groups/requests'
import {
  compareKeys,
  cursorOf,
  informationPages,
  mergePage,
  type PageKey,
  pageOptions,
  requestPages
} from './inboxPage'
import { InboxProjection } from './inboxProjection'

const now = new Date('2027-01-01T00:00:00Z')
const key = (id: string, rank = 1): PageKey => ({
  rank,
  sentAt: now.toISOString(),
  requestId: id
})
async function* stream(ids: string[]): AsyncGenerator<PageKey> {
  for (const id of ids) yield key(id)
}

describe('notification page keys and bounded streams', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  it('preserves mode precedence, limit bounds and both cursor forms before querying', () => {
    expect(
      pageOptions({
        history: true,
        sent: true,
        limit: 101,
        cursor: '2027-01-01|x'
      })
    ).deep.equals({
      mode: 'history',
      limit: 100,
      after: { rank: 1, sentAt: '2027-01-01', requestId: 'x' }
    })
    expect(pageOptions({ sent: true, limit: 0 }).mode).equals('sent')
    expect(pageOptions({ limit: 0 }).limit).equals(1)
    expect(pageOptions({})).deep.equals({
      mode: 'pending',
      limit: 25,
      after: undefined
    })
    expect(pageOptions({ cursor: '0|2027-01-01|' }).after?.rank).equals(0)
    for (const cursor of [
      'bad',
      '2|2027-01-01|x',
      '1|nonsense|x',
      '1|2027-01-01|x|extra'
    ])
      expect(() => pageOptions({ cursor })).throws(
        'Invalid notification cursor'
      )
  })
  it('orders reminders, canonical time and IDs without locale collation', () => {
    expect(compareKeys(key('z', 0), key('a'))).lessThan(0)
    expect(compareKeys({ ...key('a'), sentAt: '2026' }, key('a'))).lessThan(0)
    expect(compareKeys({ ...key('a'), sentAt: '2028' }, key('a'))).greaterThan(
      0
    )
    expect(compareKeys(key('Z'), key('a'))).lessThan(0)
    expect(compareKeys(key('b'), key('a'))).greaterThan(0)
    expect(compareKeys(key('a'), key('a'))).equals(0)
    expect(cursorOf(key('a'))).equals('1|2027-01-01T00:00:00.000Z|a')
  })
  it('merges only a page and lookahead and closes both streams', async () => {
    const a = stream(['a', 'c', 'e'])
    const b = stream(['b', 'd'])
    const closes = [mock.method(a, 'return'), mock.method(b, 'return')]
    expect(await mergePage([a, b], 2)).deep.equals({
      page: [key('a'), key('b')],
      nextCursor: cursorOf(key('b'))
    })
    expect(closes.map(x => x.mock.callCount())).deep.equals([1, 1])
    expect(await mergePage([stream([]), stream(['z'])], 2)).deep.equals({
      page: [key('z')],
      nextCursor: null
    })
    expect(await mergePage([stream([])], 1)).deep.equals({
      page: [],
      nextCursor: null
    })
  })
  it('closes both streams when the first read fails, preserving that error through cleanup', async () => {
    const error = new Error('first read failed')
    let closed = 0
    const broken: AsyncIterator<PageKey> = {
      next: async () => {
        throw error
      },
      return: async () => {
        closed++
        return { done: true, value: undefined }
      }
    }
    const other = stream(['a'])
    mock.method(other, 'return', async () => {
      closed++
      throw new Error('cleanup failed')
    })
    let caught: unknown
    try {
      await mergePage([broken, other], 1)
    } catch (e) {
      caught = e
    }
    expect(caught).equals(error)
    expect(closed).equals(2)
  })
  for (const mode of ['pending', 'sent', 'history'] as const)
    it(`ANDs ${mode} and cursor after authorized predicates with100-candidate windows`, async () => {
      let reads = 0
      const requests = Array.from({ length: 100 }, (_, i) => ({
        id: '00000000-0000-0000-0000-' + String(i).padStart(12, '0'),
        sent_at: now
      }))
      await withQueryReplies(
        query => {
          if (query.sql.startsWith('close ')) return []
          if (query.sql.startsWith('fetch ')) {
            reads++
            expect(query.sql).contains('fetch forward 100')
            return reads === 1 ? requests : []
          }
          expect(query.sql).contains('declare ')
          expect(query.sql).contains('no scroll cursor for')
          expect(query.sql).contains(
            '("sender_id" = $1 or "sender_id" = $2) and'
          )
          expect(query.sql).contains('collate "C"')
          if (mode === 'sent') {
            expect(query.sql).contains('"status" =')
            expect(query.sql).contains('"expires_at" >')
          }
          if (mode === 'history') expect(query.sql).contains('"status" !=')
          return []
        },
        async db => {
          const projection = new InboxProjection(
            db,
            { userId: 'reader', isAdmin: false, scopes: [] },
            { now: () => now }
          )
          mock.method(
            projection,
            'requests',
            async (rows: StoredRequest[]) =>
              new Map(rows.map(r => [r.id, null]))
          )
          const rows = db
            .selectFrom('group_requests')
            .selectAll()
            .where(eb =>
              eb.or([
                eb('sender_id', '=', 'reader'),
                eb('sender_id', '=', 'delegate')
              ])
            )
          const found = []
          for await (const item of requestPages(
            rows,
            projection,
            mode,
            key('before')
          ))
            found.push(item)
          expect(found).deep.equals([])
          expect(reads).equals(2)
        }
      )
    })
  it('continues past rejected rows and yields state without wording, respecting cancellation', async () => {
    await withQueryReplies(
      [
        ['declare ', []],
        [
          'fetch forward 100',
          [
            { id: 'a', sent_at: now },
            { id: 'b', sent_at: now }
          ]
        ],
        ['close ', []]
      ],
      async db => {
        const projection = new InboxProjection(
          db,
          { userId: 'reader', isAdmin: false, scopes: [] },
          { now: () => now }
        )
        mock.method(
          projection,
          'requests',
          async () =>
            new Map([
              ['a', null],
              ['b', { status: 'pending', canAct: true, news: false }]
            ])
        )
        const rows = db.selectFrom('group_requests').selectAll()
        const found = []
        for await (const item of requestPages(rows, projection, 'pending'))
          found.push(item.requestId)
        expect(found).deep.equals(['b'])
        const aborted = new AbortController()
        aborted.abort()
        expect(
          (
            await requestPages(
              rows,
              projection,
              'pending',
              undefined,
              aborted.signal
            ).next()
          ).done
        ).equals(true)
      }
    )
  })
  it('closes its server cursor on early return, abort and failures without masking the original error', async () => {
    for (const failure of [
      'return',
      'abort',
      'declare',
      'fetch',
      'projection'
    ]) {
      mock.restoreAll()
      const error = new Error(failure)
      const abort = new AbortController()
      let closed = 0
      await withQueryReplies(
        query => {
          if (query.sql.startsWith('declare ')) {
            if (failure === 'declare') throw error
            return []
          }
          if (query.sql.startsWith('close ')) {
            closed++
            if (failure === 'projection') throw new Error('transaction aborted')
            return []
          }
          expect(query.sql).contains('fetch forward 100')
          if (failure === 'fetch') throw error
          if (failure === 'abort') abort.abort()
          return [{ id: 'r', sent_at: now }]
        },
        async db => {
          const projection = new InboxProjection(
            db,
            { userId: 'reader', isAdmin: false, scopes: [] },
            { now: () => now }
          )
          mock.method(projection, 'requests', async () => {
            if (failure === 'projection') throw error
            return new Map([
              ['r', { status: 'pending', canAct: true, news: false }]
            ])
          })
          const iterator = requestPages(
            db.selectFrom('group_requests').selectAll(),
            projection,
            'pending',
            undefined,
            abort.signal
          )
          if (failure === 'return') {
            expect((await iterator.next()).value?.requestId).equals('r')
            await iterator.return(undefined)
          } else if (failure === 'abort') {
            expect((await iterator.next()).done).equals(true)
          } else {
            let caught: unknown
            try {
              await iterator.next()
            } catch (e) {
              caught = e
            }
            expect(caught).equals(error)
          }
          expect(closed).equals(failure === 'declare' ? 0 : 1)
        }
      )
    }
  })
  it('uses chat source IDs and pending reminder rank, with no information in Sent', async () => {
    for (const mode of ['pending', 'history'] as const)
      await withQueryReplies(
        query => {
          expect(query.sql).contains('chat_links')
          expect(query.sql).contains('limit')
          expect(query.parameters.at(-1)).equals(100)
          return [
            {
              id: 'event-z',
              source_id: 'link-a',
              source_type: CHAT_DEVICE_APPROVAL,
              created_at: now
            },
            {
              id: 'reminder',
              source_id: 'upload',
              source_type: RECORDING_UPLOAD,
              created_at: now
            }
          ]
        },
        async db => {
          const found = []
          for await (const item of informationPages(
            db,
            'reader',
            now,
            mode,
            key('before')
          ))
            found.push(item)
          expect(found.map(r => r.requestId)).deep.equals([
            'link-a',
            'reminder'
          ])
          expect(found[1].rank).equals(mode === 'pending' ? 0 : 1)
          expect(
            (await informationPages(db, 'reader', now, 'sent').next()).done
          ).equals(true)
        }
      )
  })
})
