/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser probes cannot reference transpiler helpers. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import { tagTargets } from '../../common/eventTags'
import type { ConcurrentScoringRig } from './concurrentScoring'

/** Real accepted writes, peer descriptions, and decorated pitch replacement. */
export async function remoteUpdates(rig: ConcurrentScoringRig): Promise<void> {
  await rig.open()
  const [a, b] = rig.clients
  const card = '[data-testid="remote-scoring-updates"]'
  const panelText = async (index: number): Promise<string> =>
    await rig.clients[index].page!.evaluate(selector => {
      const element = document.querySelector(selector)
      if (element == null) return ''
      const text = element.textContent
      return text == null ? '' : text
    }, card)
  assert.equal(await panelText(0), '')
  assert.equal(await panelText(1), '')
  await rig.pitch(0, 'Ball')
  await b.m.assertVisible({ css: card, timeout: 10000 })
  assert.match(await panelText(1), /Top 1: Ball/)
  assert.equal(
    await panelText(0),
    '',
    'Own acknowledgments must not open the stream'
  )
  let saved = await rig.api.gameEvents(rig.fixture.ids.game)
  const accepted = saved.scoringUpdates!.at(-1)!
  assert.equal(accepted.userId, rig.fixture.accounts['scorer-a'].userId)
  assert((await panelText(1)).includes(accepted.name))

  // Preserve a real decorated pitch through canonical following, then ensure
  // Undo and replacement do not inherit its identity or tag.
  const target = tagTargets(saved.currentPlay!)[0]
  assert(target != null)
  await rig.api.saveEventTag(rig.fixture.ids.game, target.id, 'good pitch')
  await rig.tap(0, '^Undo ')
  await rig.converge(0, 'tagged pitch Undo')
  saved = await rig.api.gameEvents(rig.fixture.ids.game)
  assert.equal(
    saved.currentPlay == null ? 0 : tagTargets(saved.currentPlay).length,
    0
  )
  await b.m.assertVisible({ text: 'Undo — Top 1: Ball', timeout: 10000 })
  await rig.capture('updates-undo')

  await b.m.tapOn({ text: 'Collapse scoring updates' })
  await b.m.tapOn({ text: 'Dismiss scoring updates' })
  await rig.pitch(0, 'Ball')
  await b.m.assertVisible({ text: 'Expand scoring updates', timeout: 10000 })
  assert(
    !(await panelText(1)).includes('Top 1'),
    'Reopened panel stays collapsed'
  )
  saved = await rig.api.gameEvents(rig.fixture.ids.game)
  const replacement = tagTargets(saved.currentPlay!)[0]
  assert.notEqual(replacement.id, target.id)
  assert.equal(replacement.tag, null)
  await rig.api.saveEventTag(
    rig.fixture.ids.game,
    replacement.id,
    'replacement pitch'
  )
  saved = await rig.api.gameEvents(rig.fixture.ids.game)
  assert.equal(tagTargets(saved.currentPlay!)[0].tag, 'replacement pitch')

  await b.m.tapOn({ text: 'Expand scoring updates' })
  await b.m.tapOn({ text: 'Dismiss scoring updates' })
  await rig.pitch(0, 'Called Strike')
  await b.m.assertVisible({ text: 'Collapse scoring updates', timeout: 10000 })
  await rig.capture('updates-expanded')
  for (let i = 0; i < 6; i++) await rig.pitch(0, 'Foul Ball')
  const scroll = await b.page!.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    const bounds = el.getBoundingClientRect()
    return {
      height: el.clientHeight,
      content: el.scrollHeight,
      x: bounds.x + bounds.width / 2,
      y: bounds.y
    }
  })
  assert(scroll.height <= 100)
  assert(scroll.content > scroll.height)
  await b.m.swipe({
    start: `${scroll.x},${scroll.y + 80}`,
    end: `${scroll.x},${scroll.y + 10}`,
    duration: 500
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  await rig.capture('updates-short')
  await b.m.tapOn({ text: 'Collapse scoring updates' })
  await rig.capture('updates-collapsed')
  const geometry = await b.page!.evaluate(selector => {
    const panel = document.querySelector(selector)!.getBoundingClientRect()
    const undo = document
      .querySelector('[aria-label^="Undo "]')!
      .getBoundingClientRect()
    return {
      width: panel.width,
      height: panel.height,
      undoWidth: undo.width,
      bottom: panel.bottom,
      undoTop: undo.top
    }
  }, card)
  assert(geometry.width <= geometry.undoWidth)
  assert(geometry.height <= 48)
  assert(geometry.bottom <= geometry.undoTop)
  await rig.pitch(1, 'Ball')
  await a.m.assertVisible({ css: card, timeout: 10000 })
  saved = await rig.api.gameEvents(rig.fixture.ids.game)
  assert.equal(
    saved.scoringUpdates!.at(-1)!.userId,
    rig.fixture.accounts['scorer-b'].userId
  )
  assert((await panelText(0)).includes(saved.scoringUpdates!.at(-1)!.name))
  await writeFile(
    rig.ctx.artifact('updates-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        geometry,
        scroll,
        decoratedUndoReplacement: true,
        acceptedUpdates: saved.scoringUpdates,
        interventions: 0
      },
      null,
      2
    )
  )
}
