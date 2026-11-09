import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import type { HTTPRequest } from 'puppeteer'

import type { ConcurrentScoringRig } from './concurrentScoring'

/** Both authors start on one version; choose which request reaches the server first. */
export async function conflictingPitches(
  rig: ConcurrentScoringRig
): Promise<void> {
  await rig.open()
  const older = Number(process.env.TS_CONCURRENT_OLDER_AUTHOR ?? 0)
  assert(older === 0 || older === 1)
  const newer = 1 - older
  const first = Number(process.env.TS_CONCURRENT_FIRST_AUTHOR ?? newer)
  assert(first === 0 || first === 1)
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
  const held: Array<HTTPRequest | undefined> = []
  const holding = [true, true]
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
      const onRequest = (request: HTTPRequest): void => {
        if (isWrite(request)) {
          pending++
          evidence.push({
            author: index,
            requestAt: Date.now(),
            body: JSON.parse(request.postData()!)
          })
          if (holding[index]) {
            assert(
              held[index] == null,
              'Only one original pitch per author is held'
            )
            held[index] = request
            return
          }
        }
        request.continue().catch(() => undefined)
      }
      const answered = (request: HTTPRequest): void => {
        if (!isWrite(request)) return
        pending--
        lastAnswer = Date.now()
        evidence.push({
          author: index,
          answeredAt: lastAnswer,
          status: request.response()?.status()
        })
      }
      await page.setRequestInterception(true)
      page.on('request', onRequest)
      page.on('requestfinished', answered)
      page.on('requestfailed', answered)
      cleanup.push(async () => {
        if (holding[index] && held[index] != null)
          await held[index].abort().catch(() => undefined)
        page.off('request', onRequest)
        page.off('requestfinished', answered)
        page.off('requestfailed', answered)
        await page.setRequestInterception(false)
      })
    }
    await rig.tap(older, '^Ball$')
    await wait(async () => held[older] != null, 'older pitch held')
    await rig.tap(newer, '^Called Strike$')
    await wait(async () => held[newer] != null, 'newer pitch held')
    holding[first] = false
    evidence.push({ firstAcceptedAuthor: first, releasedAt: Date.now() })
    await held[first]!.continue()
    await wait(
      async () =>
        JSON.stringify(
          countOf(await rig.api.gameEvents(rig.fixture.ids.game))
        ) === JSON.stringify(expected),
      'first request accepted'
    )
    holding[1 - first] = false
    await held[1 - first]!.continue()
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
