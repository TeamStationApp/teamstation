import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import type { HTTPRequest } from '../../../e2e/core/web'
import type { ConcurrentScoringRig } from './concurrentScoring'

/**
 * Both authors start on one version; choose which request reaches the
 * server first. `older` scores first (a Ball), the other second (a Called
 * Strike); `first` is the one whose save reaches the server first. Each
 * author's saves are held by taking that browser off the network
 * (maestro-d's setNetworkConditions) and released by bringing it back.
 */
export async function conflictingPitches(
  rig: ConcurrentScoringRig,
  older: 0 | 1,
  first: 0 | 1
): Promise<void> {
  await rig.open()
  const newer = 1 - older
  const expected =
    first === older ? { balls: 1, strikes: 0 } : { balls: 0, strikes: 1 }
  const countOf = (
    events: Awaited<ReturnType<typeof rig.api.gameEvents>>
  ): { balls: unknown; strikes: unknown } | undefined => {
    const count = events.currentPlay?.count
    if (count == null) return undefined
    assert(typeof count === 'object' && 'balls' in count && 'strikes' in count)
    return { balls: count.balls, strikes: count.strikes }
  }
  const path = `/games/${rig.fixture.ids.game}/events`
  const isWrite = (request: HTTPRequest): boolean =>
    request.method() === 'POST' &&
    new URL(request.url()).pathname.endsWith(path)
  /** The body of each author's held save: a retry carries the same one. */
  const held: Array<string | undefined> = []
  const holding = [true, true]
  /** Saves sent once released, until each is answered or fails. */
  const sent = new Set<HTTPRequest>()
  let pending = 0
  let lastAnswer = 0
  const evidence: unknown[] = []
  const wait = async (
    check: () => Promise<boolean>,
    label: string
  ): Promise<void> => {
    const until = Date.now() + 15000
    while (!(await check())) {
      if (Date.now() > until) throw new Error(`Timed out: ${label}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const cleanup: Array<() => Promise<void>> = []
  try {
    for (const index of [0, 1]) {
      const page = rig.clients[index].page
      assert(page != null, 'Deterministic request holding requires Chromium')
      const m = rig.clients[index].m
      const onRequest = (request: HTTPRequest): void => {
        if (!isWrite(request)) return
        const body = request.postData()!
        evidence.push({
          author: index,
          requestAt: Date.now(),
          held: holding[index],
          body: JSON.parse(body)
        })
        if (holding[index]) {
          // Offline, the browser fails each attempt and the screen sends the
          // same save again: one original pitch per author is held.
          assert(
            held[index] == null || held[index] === body,
            'Only one original pitch per author is held'
          )
          held[index] = body
          return
        }
        sent.add(request)
        pending++
      }
      const answered = (request: HTTPRequest): void => {
        if (!sent.delete(request)) return
        pending--
        lastAnswer = Date.now()
        evidence.push({
          author: index,
          answeredAt: lastAnswer,
          status: request.response()?.status()
        })
      }
      page.on('request', onRequest)
      page.on('requestfinished', answered)
      page.on('requestfailed', answered)
      await m.setNetworkConditions({ offline: true })
      cleanup.push(async () => {
        page.off('request', onRequest)
        page.off('requestfinished', answered)
        page.off('requestfailed', answered)
        await m.setNetworkConditions({ offline: false })
      })
    }
    await rig.tap(older, '^Ball$')
    await wait(async () => held[older] != null, 'older pitch held')
    await rig.tap(newer, '^Called Strike$')
    await wait(async () => held[newer] != null, 'newer pitch held')
    holding[first] = false
    evidence.push({ firstAcceptedAuthor: first, releasedAt: Date.now() })
    await rig.clients[first].m.setNetworkConditions({ offline: false })
    await wait(
      async () =>
        JSON.stringify(
          countOf(await rig.api.gameEvents(rig.fixture.ids.game))
        ) === JSON.stringify(expected),
      'first request accepted'
    )
    holding[1 - first] = false
    await rig.clients[1 - first].m.setNetworkConditions({ offline: false })
    await wait(
      async () =>
        pending === 0 && lastAnswer !== 0 && Date.now() - lastAnswer >= 3000,
      'conflicting requests and recovery settle'
    )
    const events = await rig.api.gameEvents(rig.fixture.ids.game)
    evidence.push({ finalAt: Date.now(), events })
    assert.deepEqual(
      countOf(events),
      expected,
      'First server-accepted pitch must survive either device clock order'
    )
    await rig.converge(first, 'first accepted conflicting pitch')
    await rig.capture('conflict-final')
    await rig.pitch(1 - first, 'Ball')
    assert.deepEqual(
      countOf(await rig.api.gameEvents(rig.fixture.ids.game)),
      { ...expected, balls: expected.balls + 1 },
      'Rejected scorer can continue after canonical adoption'
    )
  } finally {
    for (const close of cleanup.reverse()) await close()
    await writeFile(
      rig.ctx.artifact('conflict-delivery.json'),
      JSON.stringify(evidence, null, 2)
    )
  }
}
