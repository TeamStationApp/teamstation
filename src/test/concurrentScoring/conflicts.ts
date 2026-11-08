import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import type { HTTPRequest } from 'puppeteer'

import type { ConcurrentScoringRig } from './concurrentScoring'

/** Release the older pitch only after the newer pitch is stored. */
export async function conflictingPitches(
  rig: ConcurrentScoringRig
): Promise<void> {
  await rig.open()
  const older = Number(process.env.TS_CONCURRENT_OLDER_AUTHOR ?? 0)
  assert(older === 0 || older === 1)
  const newer = 1 - older
  const countOf = (
    events: Awaited<ReturnType<typeof rig.api.gameEvents>>
  ): { balls: unknown; strikes: unknown } | undefined => {
    const count = events.currentPlay?.count
    if (count == null) return undefined
    assert(
      count != null &&
        typeof count === 'object' &&
        'balls' in count &&
        'strikes' in count
    )
    return { balls: count.balls, strikes: count.strikes }
  }
  const page = rig.clients[older].page
  assert(page != null, 'Deterministic request holding requires Chromium')
  const path = `/games/${rig.fixture.ids.game}/events`
  const isWrite = (request: HTTPRequest): boolean =>
    request.method() === 'POST' &&
    new URL(request.url()).pathname.endsWith(path)
  let held: HTTPRequest | undefined
  let holding = true
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
  const onRequest = (request: HTTPRequest): void => {
    if (isWrite(request)) {
      pending++
      evidence.push({
        requestAt: Date.now(),
        body: JSON.parse(request.postData()!)
      })
      if (holding) {
        assert(held == null, 'Only one original pitch is held')
        held = request
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
      answeredAt: lastAnswer,
      status: request.response()?.status()
    })
  }
  await page.setRequestInterception(true)
  page.on('request', onRequest)
  page.on('requestfinished', answered)
  page.on('requestfailed', answered)
  try {
    evidence.push({ author: older, action: 'Ball', at: Date.now() })
    await rig.tap(older, '^Ball$')
    await wait(async () => held != null, 'the older pitch request')
    evidence.push({ author: newer, action: 'Called Strike', at: Date.now() })
    await rig.tap(newer, '^Called Strike$')
    await wait(async () => {
      const events = await rig.api.gameEvents(rig.fixture.ids.game)
      const count = countOf(events)
      return count?.balls === 0 && count?.strikes === 1
    }, 'the newer strike saved before the older request arrives')
    holding = false
    evidence.push({ releasedOlderAt: Date.now() })
    await held!.continue()
    await wait(
      async () =>
        pending === 0 && lastAnswer !== 0 && Date.now() - lastAnswer >= 3000,
      'the older write and any rebased retries to settle'
    )
    const events = await rig.api.gameEvents(rig.fixture.ids.game)
    evidence.push({ finalAt: Date.now(), events })
    await writeFile(
      rig.ctx.artifact('conflict-delivery.json'),
      JSON.stringify(evidence, null, 2)
    )
    assert.deepEqual(
      countOf(events),
      { balls: 0, strikes: 1 },
      'The newer original pitch must win, even though the older request arrived last'
    )
    await rig.converge(newer, 'newer conflicting pitch')
    await rig.capture('conflict-final')
  } finally {
    if (holding && held != null) await held.abort().catch(() => undefined)
    page.off('request', onRequest)
    page.off('requestfinished', answered)
    page.off('requestfailed', answered)
    await page.setRequestInterception(false)
    await writeFile(
      rig.ctx.artifact('conflict-delivery.json'),
      JSON.stringify(evidence, null, 2)
    )
  }
}
