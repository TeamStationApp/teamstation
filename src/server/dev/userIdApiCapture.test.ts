import { expect } from 'chai'
import { describe, it } from 'mocha'

import { captureEndpoint } from './userIdApiCapture'

async function failure(run: Promise<unknown>, message: string): Promise<void> {
  let error: unknown
  try {
    await run
  } catch (e) {
    error = e
  }
  expect(String(error)).contains(message)
}

describe('complete identity API capture', () => {
  it('follows every cursor, records ordered identities and keeps business metadata', async () => {
    const calls: string[] = []
    const request: typeof fetch = async input => {
      calls.push(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      )
      return Response.json(
        calls.length === 1
          ? {
              items: [{ id: 'one' }],
              nextCursor: 'page/2',
              total: 2,
              label: 'unchanged'
            }
          : {
              items: [{ id: 'two' }],
              nextCursor: null,
              total: 2,
              label: 'unchanged'
            }
      )
    }
    const result = await captureEndpoint(
      '/teams?season=x',
      'https://example.test/',
      'synthetic',
      request
    )
    expect(calls).deep.equals([
      'https://example.test/teams?season=x',
      'https://example.test/teams?season=x&cursor=page%2F2'
    ])
    expect(result).deep.equals({
      body: {
        items: [{ id: 'one' }, { id: 'two' }],
        nextCursor: null,
        total: 2,
        label: 'unchanged'
      },
      inventory: { status: 200, pages: 2, total: 2, itemIds: ['one', 'two'] }
    })
  })
  it('fails on repeated cursors, duplicates, omissions, changed totals and lost envelopes', async () => {
    for (const [next, message] of [
      [{ items: [{ id: 'two' }], nextCursor: 'next', total: 3 }, 'Repeated'],
      [{ items: [{ id: 'one' }], nextCursor: null, total: 3 }, 'Duplicate'],
      [{ items: [{ id: 'two' }], nextCursor: null, total: 3 }, 'Truncated'],
      [
        { items: [{ id: 'two' }], nextCursor: null, total: 2 },
        'metadata changed'
      ],
      [[{ id: 'two' }], 'envelope changed']
    ] as const) {
      let call = 0
      await failure(
        captureEndpoint(
          '/teams',
          'https://example.test',
          'synthetic',
          async () =>
            Response.json(
              ++call === 1
                ? { items: [{ id: 'one' }], nextCursor: 'next', total: 3 }
                : next
            )
        ),
        message
      )
    }
  })
  it('rejects unknown pagination, malformed envelopes, failed statuses and duplicate array items', async () => {
    for (const body of [
      { nextPage: 2 },
      { hasMore: true },
      { nextBefore: 'later' },
      { nextCursor: null },
      { items: [], nextCursor: null, total: -1 },
      { items: [], nextCursor: 42, total: 0 },
      { items: [{}], nextCursor: null, total: 1 },
      [{ id: 'one' }, { id: 'one' }]
    ])
      await failure(
        captureEndpoint(
          '/teams',
          'https://example.test',
          'synthetic',
          async () => Response.json(body)
        ),
        'Error'
      )
    await failure(
      captureEndpoint('/teams', 'https://example.test', 'synthetic', async () =>
        Response.json({}, { status: 500 })
      ),
      '(500)'
    )
  })
  it('records unpaginated responses and composite play identities without sorting', async () => {
    const result = await captureEndpoint(
      '/players/1/plays',
      'https://example.test',
      'synthetic',
      async () =>
        Response.json([
          { eventId: 'b', role: 'pitcher' },
          { eventId: 'b', role: 'batter' }
        ])
    )
    expect(result.inventory).deep.equals({
      status: 200,
      pages: 1,
      total: 2,
      itemIds: ['b:pitcher', 'b:batter']
    })
    const object = await captureEndpoint(
      '/players/1/stats',
      'https://example.test',
      'synthetic',
      async () => Response.json({ batting: null })
    )
    expect(object.inventory).deep.equals({
      status: 200,
      pages: 1,
      total: null,
      itemIds: []
    })
  })
})
