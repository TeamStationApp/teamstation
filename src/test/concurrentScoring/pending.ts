/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser probes cannot reference transpiler helpers. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import type { HTTPRequest } from 'puppeteer'

import type { ConcurrentScoringRig } from './concurrentScoring'

/**
 * A remote pitch accepted while this device's saves are still in flight:
 * scorer B's post is held while B records a ball and A records a
 * called strike. Released, B's post is superseded and B's session rebases
 * on the server's history. Each panel credits only the other scorer, by
 * name, with what the server accepted from them.
 */
export async function pendingStretch(rig: ConcurrentScoringRig): Promise<void> {
  await rig.open()
  const card = '[data-testid="remote-scoring-updates"]'
  const panelText = async (index: number): Promise<string> =>
    await rig.clients[index].page!.evaluate(selector => {
      const element = document.querySelector(selector)
      if (element == null) return ''
      const text = element.textContent
      return text == null ? '' : text
    }, card)
  const path = `/games/${rig.fixture.ids.game}/events`
  const isWrite = (request: HTTPRequest): boolean =>
    request.method() === 'POST' &&
    new URL(request.url()).pathname.endsWith(path)
  const page = rig.clients[1].page
  assert(page != null, 'Holding requests requires Chromium')
  const held: HTTPRequest[] = []
  let holding = true
  const onRequest = (request: HTTPRequest): void => {
    if (holding && isWrite(request)) {
      held.push(request)
      return
    }
    request.continue().catch(() => undefined)
  }
  const wait = async (
    check: () => Promise<boolean>,
    label: string
  ): Promise<void> => {
    const until = Date.now() + 20000
    while (!(await check())) {
      if (Date.now() > until) throw new Error(`Timed out: ${label}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const evidence: unknown[] = []
  await page.setRequestInterception(true)
  page.on('request', onRequest)
  try {
    // The screen takes no further pitch while its save is unanswered, so B's
    // stretch holds one Ball.
    await rig.tap(1, '^Ball$')
    await wait(async () => held.length > 0, 'B save held')
    // A's strike is accepted while B's save is held: the screens differ until
    // B's save is answered, so this is no converging pitch.
    await rig.tap(0, '^Called Strike$')
    await wait(
      async () =>
        Object.values(
          (await rig.api.gameEvents(rig.fixture.ids.game)).scoringAuthorship
            ?.plays ?? {}
        ).flat().length === 1,
      "A's strike accepted"
    )
    const accepted = await rig.api.gameEvents(rig.fixture.ids.game)
    evidence.push({ whileHeld: accepted.scoringAuthorship })
    holding = false
    for (const request of held.splice(0)) await request.continue()
    await rig.converge(0, 'superseded pending saves rebased')
    await rig.capture('pending-stretch-after')
    const remote = await panelText(1)
    const a = rig.fixture.accounts['scorer-a'].userId
    const b = rig.fixture.accounts['scorer-b'].userId
    // Each panel names a scorer as its own reader may read them, so check
    // the row and the server's credit rather than one spelling of a name.
    assert(remote.includes(': Called strike'), remote)
    assert(!remote.includes('Ball'), 'B never sees its own pitches')
    // B's competing pitches from the stale version do not survive; B then
    // scores on the accepted history and A sees exactly that, credited.
    await rig.pitch(1, 'Ball')
    await wait(
      async () => (await panelText(0)).includes(': Ball'),
      'A sees B credited'
    )
    const final = await rig.api.gameEvents(rig.fixture.ids.game)
    const authors = Object.values(final.scoringAuthorship!.plays).flat()
    assert.deepEqual(authors, [a, b])
    evidence.push({ final: final.scoringAuthorship })
  } finally {
    page.off('request', onRequest)
    await page.setRequestInterception(false)
    await writeFile(
      rig.ctx.artifact('pending-stretch.json'),
      JSON.stringify(evidence, null, 2)
    )
  }
}
