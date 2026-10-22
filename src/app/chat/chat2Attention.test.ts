import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import {
  AttentionCancelled,
  ChatHistoryCoordinator,
  discoverAttentionHistory
} from './chatAttentionHistory'
import {
  attentionBodyBelow,
  attentionBodyViewed,
  attentionMessages,
  attentionReferences,
  newAttentionSession,
  projectAttentionHistory,
  recordAttentionPage,
  revealAttentionEarlier,
  revealAttentionTarget
} from './chatAttentionModel'
import { message, view } from './chatViews.test.helpers'
import type { ConversationView } from './engine/engine'

const opened = (over: Partial<ConversationView> = {}): ConversationView =>
  view({
    conversation: { ...view().conversation, lastSeq: 300 },
    readsReady: true,
    ownReadSeq: 200,
    historyBefore: 201,
    ...over
  })
const session = (): NonNullable<ReturnType<typeof newAttentionSession>> =>
  newAttentionSession(opened())!
const quote = {
  id: 'msg_original',
  authorId: userIdOfGumbo(1),
  authorName: 'Aaron Judge',
  snippet: 'Claimed words',
  status: 'unavailable' as const
}

describe('session attention classification and history projection', function () {
  it('requires completed read synchronization and treats a legitimate absent own read as zero', function () {
    expect(newAttentionSession(opened({ readsReady: false }))).equals(undefined)
    expect(newAttentionSession(opened({ ownReadSeq: undefined }))).equals(
      undefined
    )
    expect(newAttentionSession(opened({ ownReadSeq: 0 }))!.boundary).equals(0)
    expect(newAttentionSession(opened({ ownReadSeq: -1 }))).equals(undefined)
    expect(newAttentionSession(opened({ ownReadSeq: NaN }))).equals(undefined)
    expect(
      newAttentionSession(
        opened({ historyBefore: undefined, messages: [message({ seq: 220 })] })
      )!.floor
    ).equals(220)
    expect(
      newAttentionSession(
        opened({
          historyBefore: undefined,
          messages: [],
          conversation: { ...opened().conversation, lastSeq: 300 }
        })
      )!.floor
    ).equals(301)
    expect(
      newAttentionSession(opened({ messages: [] }))!.floor,
      'Operations-only initial pages retain the raw frontier'
    ).equals(201)
  })

  it('uses current verified originals, deduplicates mention plus reply and never resurrects a seen edit', function () {
    const original = message({
      id: quote.id,
      seq: 20,
      mine: true,
      senderUserId: userIdOfGumbo(1)
    })
    const reply = message({
      id: 'msg_reply',
      seq: 220,
      quote,
      mentions: [userIdOfGumbo(1)]
    })
    const mention = message({
      id: 'msg_mention',
      seq: 210,
      mentions: [userIdOfGumbo(1)]
    })
    const claimed = message({
      id: 'msg_claimed',
      seq: 230,
      quote: { ...quote, id: 'msg_missing' }
    })
    const state = session()
    const current = opened({
      messages: [
        reply,
        claimed,
        original,
        mention,
        message({
          id: 'msg_own',
          seq: 240,
          mine: true,
          mentions: [userIdOfGumbo(1)]
        }),
        message({
          id: 'msg_own_id',
          seq: 241,
          senderUserId: userIdOfGumbo(1),
          mentions: [userIdOfGumbo(1)]
        }),
        message({ id: 'msg_read', seq: 200, mentions: [userIdOfGumbo(1)] })
      ]
    })
    expect(
      attentionMessages(current, userIdOfGumbo(1), state).map(value => value.id)
    ).deep.equals(['msg_mention', 'msg_reply'])
    expect(
      attentionReferences(current, userIdOfGumbo(1), state.boundary)
    ).deep.equals([quote.id, 'msg_missing'])
    for (const status of ['locked', 'lost', 'invalid', 'removed'] as const) {
      expect(
        attentionMessages(
          opened({
            messages: [
              { ...reply, mentions: [] },
              { ...original, status }
            ]
          }),
          userIdOfGumbo(1),
          state
        )
      ).deep.equals([])
      expect(
        attentionMessages(
          opened({ messages: [{ ...mention, status }] }),
          userIdOfGumbo(1),
          state
        )
      ).deep.equals([])
    }
    expect(
      attentionMessages(
        { ...current, unverified: true },
        userIdOfGumbo(1),
        state
      )
    ).deep.equals([])
    expect(
      attentionReferences(
        { ...current, unverified: true },
        userIdOfGumbo(1),
        state.boundary
      )
    ).deep.equals([])
    state.seen.add(mention.id)
    expect(
      attentionMessages(current, userIdOfGumbo(1), state).map(value => value.id)
    ).deep.equals(['msg_reply'])
    expect(
      attentionMessages(
        opened({
          messages: [{ ...mention, edited: true, body: 'New wording' }]
        }),
        userIdOfGumbo(1),
        state
      )
    ).deep.equals([])
    expect(
      attentionMessages(
        opened({
          messages: [
            { ...reply, mentions: [] },
            { ...original, senderUserId: userIdOfGumbo(3), mine: false }
          ]
        }),
        userIdOfGumbo(1),
        state
      )
    ).deep.equals([])
  })

  it('keeps cached older rows hidden until ordinary reveal even after server exhaustion, and reveals jump targets first', function () {
    const state = session()
    const current = opened({
      hasEarlier: false,
      historyBefore: 20,
      messages: [
        message({ id: 'msg_original', seq: 20 }),
        message({ id: 'msg_old', seq: 100 }),
        message({ id: 'msg_recent', seq: 220 }),
        message({ id: 'msg_arrival', seq: 230 })
      ]
    })
    expect(projectAttentionHistory(current, undefined)).equals(current)
    recordAttentionPage(state, opened({ historyBefore: undefined }))
    recordAttentionPage(state, opened({ historyBefore: 100 }))
    recordAttentionPage(state, current)
    expect(
      projectAttentionHistory(current, state).messages.map(value => value.seq)
    ).deep.equals([220, 230])
    expect(projectAttentionHistory(current, state).hasEarlier).equals(true)
    expect(revealAttentionEarlier(state, current)).equals(true)
    expect(state.floor).equals(100)
    expect(revealAttentionEarlier(state, current)).equals(true)
    expect(state.floor).equals(20)
    expect(revealAttentionEarlier(state, current)).equals(false)
    expect(projectAttentionHistory(current, state).hasEarlier).equals(false)
    state.floor = 201
    revealAttentionTarget(state, current.messages[0])
    expect(projectAttentionHistory(current, state).messages[0].id).equals(
      'msg_original'
    )
    const fallback = session()
    expect(revealAttentionEarlier(fallback, current)).equals(true)
    expect(fallback.floor).equals(20)
  })

  it('requires a meaningful leading body inside the unobscured band and permits only actual manual passing', function () {
    const area = { top: 120, bottom: 600 }
    expect(attentionBodyViewed({ top: 130, height: 3000 }, area)).equals(true)
    expect(attentionBodyViewed({ top: 590, height: 3000 }, area)).equals(false)
    expect(attentionBodyBelow({ top: 590, height: 3000 }, area)).equals(true)
    expect(attentionBodyViewed({ top: 80, height: 3000 }, area)).equals(false)
    expect(attentionBodyViewed({ top: 80, height: 3000 }, area, true)).equals(
      true
    )
    expect(attentionBodyViewed({ top: 595, height: 4 }, area)).equals(true)
    for (const body of [
      { top: NaN, height: 100 },
      { top: 130, height: 0 },
      { top: 130, height: Infinity }
    ])
      expect(attentionBodyViewed(body, area)).equals(false)
    expect(
      attentionBodyViewed({ top: 130, height: 100 }, { top: 600, bottom: 120 })
    ).equals(false)
    expect(attentionBodyBelow({ top: 130, height: 100 }, area)).equals(false)
  })
})

function paging(
  initial: ConversationView,
  pages: ConversationView[]
): {
  readonly calls: number
  current: ConversationView | undefined
  options: Parameters<typeof discoverAttentionHistory>[0]
} {
  let current: ConversationView | undefined = initial
  let calls = 0
  return {
    get calls() {
      return calls
    },
    get current() {
      return current
    },
    set current(value: ConversationView | undefined) {
      current = value
    },
    options: {
      conversationId: initial.conversation.id,
      userId: userIdOfGumbo(1),
      session: newAttentionSession(initial)!,
      view: () => current,
      loadEarlier: async () => {
        calls += 1
        const next = pages.shift()
        if (next == null) throw new Error('Unavailable')
        current = next
        return next
      },
      cancelled: () => false
    }
  }
}

describe('bounded serialized ordinary attention history', function () {
  it('verifies cold unread reply220 after read200 against own original20 and stops once all duplicate references resolve', async function () {
    const reply = message({ id: 'msg_reply', seq: 220, quote })
    const second = message({ id: 'msg_second', seq: 221, quote })
    const initial = opened({ messages: [reply, second], hasEarlier: true })
    const loaded = paging(initial, [
      opened({
        messages: [reply, second],
        historyBefore: 100,
        hasEarlier: true
      }),
      opened({
        messages: [
          message({
            id: quote.id,
            seq: 20,
            senderUserId: userIdOfGumbo(1),
            mine: true
          }),
          reply,
          second
        ],
        historyBefore: 20,
        hasEarlier: true
      })
    ])
    await discoverAttentionHistory(loaded.options)
    expect(loaded.calls).equals(2)
    expect(
      attentionMessages(
        loaded.current!,
        userIdOfGumbo(1),
        loaded.options.session
      ).map(value => value.id)
    ).deep.equals(['msg_reply', 'msg_second'])
    expect(loaded.options.session.floor).equals(201)
    expect(
      projectAttentionHistory(loaded.current!, loaded.options.session).messages
    ).length(2)
  })

  it('advances raw operation-only pages without needing a visible post and resumes after a spent budget or a network failure', async function () {
    const initial = opened({
      historyBefore: 500,
      messages: [],
      hasEarlier: true
    })
    const loaded = paging(initial, [
      opened({ historyBefore: 400, messages: [], hasEarlier: true }),
      opened({ historyBefore: 300, messages: [], hasEarlier: true }),
      opened({ historyBefore: 201, messages: [], hasEarlier: true })
    ])
    // A spent budget with the cursor moving is progress, not a failure.
    expect(
      await discoverAttentionHistory({ ...loaded.options, budget: 1 })
    ).equals('more')
    expect(loaded.calls).equals(1)
    expect(await discoverAttentionHistory(loaded.options)).equals('complete')
    expect(loaded.calls).equals(3)
    const network = paging(initial, [])
    expect(
      await discoverAttentionHistory(network.options).catch(
        (error: unknown) => error
      )
    ).instanceOf(Error)
  })

  it('walks a first visit (read 0) longer than its budget in batches that each report progress', async function () {
    const target = message({
      id: 'msg_mention',
      seq: 1450,
      mentions: [userIdOfGumbo(1)]
    })
    const first = (over: Partial<ConversationView>): ConversationView =>
      opened({
        conversation: { ...opened().conversation, lastSeq: 1500 },
        ownReadSeq: 0,
        messages: [target],
        hasEarlier: true,
        ...over
      })
    // 14 pages of 100 back to the boundary: more than one 12-page budget.
    const pages = Array.from({ length: 14 }, (_, index) =>
      first({ historyBefore: 1301 - 100 * index })
    )
    const loaded = paging(first({ historyBefore: 1401 }), pages)
    expect(loaded.options.session.boundary).equals(0)
    const results: string[] = []
    for (let batch = 0; batch < 5; batch++) {
      const result = await discoverAttentionHistory(loaded.options)
      results.push(result)
      if (result === 'complete') break
    }
    expect(results).deep.equals(['more', 'complete'])
    expect(loaded.calls).equals(14)
    expect(loaded.current!.historyBefore).equals(1)
    expect(
      attentionMessages(
        loaded.current!,
        userIdOfGumbo(1),
        loaded.options.session
      ).map(value => value.id)
    ).deep.equals(['msg_mention'])
  })

  it('rejects stalled or missing raw cursors while allowing honest terminal exhaustion and unavailable references', async function () {
    for (const historyBefore of [500, undefined]) {
      const loaded = paging(opened({ historyBefore: 500, hasEarlier: true }), [
        opened({ historyBefore, hasEarlier: true })
      ])
      expect(
        await discoverAttentionHistory(loaded.options).catch(
          (error: unknown) => error
        )
      ).instanceOf(Error)
      expect(loaded.calls).equals(1)
    }
    const reply = message({ id: 'msg_reply', seq: 220, quote })
    const exhausted = paging(opened({ hasEarlier: true, messages: [reply] }), [
      opened({ hasEarlier: false, messages: [reply] })
    ])
    await discoverAttentionHistory(exhausted.options)
    expect(
      attentionMessages(
        exhausted.current!,
        userIdOfGumbo(1),
        exhausted.options.session
      )
    ).deep.equals([])
  })

  it('cancels before a request and after its response without starting another page, and rejects lost access', async function () {
    const initial = opened({ historyBefore: 500, hasEarlier: true })
    const loaded = paging(initial, [
      opened({ historyBefore: 400, hasEarlier: true })
    ])
    expect(
      await discoverAttentionHistory({
        ...loaded.options,
        cancelled: () => true
      }).catch((error: unknown) => error)
    ).instanceOf(AttentionCancelled)
    expect(loaded.calls).equals(0)
    let cancel = false
    const load = loaded.options.loadEarlier
    expect(
      await discoverAttentionHistory({
        ...loaded.options,
        cancelled: () => cancel,
        loadEarlier: async () => {
          const next = await load(initial.conversation.id)
          cancel = true
          return next
        }
      }).catch((error: unknown) => error)
    ).instanceOf(AttentionCancelled)
    expect(loaded.calls).equals(1)
    expect(loaded.options.session.frontiers.has(400)).equals(true)
    loaded.current = undefined
    expect(
      await discoverAttentionHistory(loaded.options).catch(
        (error: unknown) => error
      )
    ).instanceOf(Error)
  })

  it('serializes complete page work, skips cancelled queued requests and recovers after a rejected request', async function () {
    const coordinator = new ChatHistoryCoordinator()
    const order: string[] = []
    let finish!: () => void
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    const first = coordinator.run(
      () => false,
      async () => {
        order.push('first')
        await gate
        order.push('finished')
        return 1
      }
    )
    const cancelled = coordinator
      .run(
        () => true,
        async () => {
          order.push('cancelled')
          return 2
        }
      )
      .catch((error: unknown) => error)
    const failed = coordinator
      .run(
        () => false,
        async () => {
          order.push('failed')
          throw new Error('Unavailable')
        }
      )
      .catch((error: unknown) => error)
    const recovered = coordinator.run(
      () => false,
      async () => {
        order.push('recovered')
        return 3
      }
    )
    await Promise.resolve()
    expect(order).deep.equals(['first'])
    finish()
    expect(await first).equals(1)
    expect(await cancelled).instanceOf(AttentionCancelled)
    expect(await failed).instanceOf(Error)
    expect(await recovered).equals(3)
    expect(order).deep.equals(['first', 'finished', 'failed', 'recovered'])
  })
})
