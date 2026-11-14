/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser probes cannot reference transpiler helpers. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import { TeamStationClient } from '../../common/api'
import { tagTargets } from '../../common/eventTags'
import type { StoredGame } from '../../common/scoring/session'
import { testPasswordKdf } from '../passwordFixtures'
import type { ConcurrentScoringRig } from './concurrentScoring'

/** The author the server credits with the latest stored action. */
function lastAuthor(saved: StoredGame): string | null {
  const plays = saved.scoringAuthorship?.plays ?? {}
  const last = Object.keys(plays)
    .map(Number)
    .sort((a, b) => a - b)
    .at(-1)
  return last == null ? null : (plays[String(last)].at(-1) ?? null)
}

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
  // Each save's answer, as scorer A's page receives it, for the evidence.
  const answers: Array<{ keys: string[]; scoringAuthorship: unknown }> = []
  a.page!.on('response', response => {
    if (
      response.request().method() !== 'POST' ||
      !new URL(response.url()).pathname.endsWith(
        `/games/${rig.fixture.ids.game}/events`
      )
    )
      return
    response
      .json()
      .then((body: Record<string, unknown>) =>
        answers.push({
          keys: Object.keys(body),
          scoringAuthorship: body.scoringAuthorship
        })
      )
      .catch(() => undefined)
  })
  await rig.pitch(0, 'Ball')
  await b.m.assertVisible({ css: card, timeout: 10000 })
  assert.match(await panelText(1), /Ball/)
  assert(!(await panelText(1)).includes('Top 1:'))
  assert.equal(
    await panelText(0),
    '',
    'Own acknowledgments must not open the stream'
  )
  let saved = await rig.api.gameEvents(rig.fixture.ids.game)
  const author = lastAuthor(saved)
  assert.equal(author, rig.fixture.accounts['scorer-a'].userId)
  // A viewer's public author label can differ from the author's own full name.
  const viewer = new TeamStationClient({
    baseUrl: `${rig.ctx.stack.origin}/api/v1`,
    passwordKdf: testPasswordKdf
  })
  const account = rig.fixture.accounts['scorer-b']
  viewer.token = (
    await viewer.signInWithPassword(account.email, account.password)
  ).token
  const viewed = await viewer.gameEvents(rig.fixture.ids.game)
  assert.equal(lastAuthor(viewed), author)
  assert((await panelText(1)).includes(viewed.scoringAuthorship!.names[author]))

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
  const undoName = saved.scoringAuthorship?.names[author]
  await b.m.assertVisible({ text: 'Undo — Ball', timeout: 10000 })
  // The row is the client's own wording, credited to the scorer who undid.
  assert.match(await panelText(1), /[^:]+: Undo — Ball/)
  assert.equal(saved.scoringAuthorship!.removals.at(-1)?.userId, author)
  assert(undoName != null)
  await writeFile(
    rig.ctx.artifact('authorship-answer.json'),
    JSON.stringify(
      {
        read: {
          keys: Object.keys(saved),
          scoringAuthorship: saved.scoringAuthorship
        },
        saveAnswers: answers
      },
      null,
      2
    )
  )
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
  await rig.hit(0, 'Single')
  await rig.finish(0)
  await rig.converge(0, 'single after pitches')
  assert.match(await panelText(1), /single/i)
  assert(!(await panelText(1)).includes('after ball'))
  // Repeated fouls are compressed by the shared Undo formatter. Use several
  // completed plays to make genuine history that requires scrolling.
  for (let batter = 0; batter < 2; batter++) {
    for (let pitch = 0; pitch < 4; pitch++)
      await rig.pitch(0, 'Ball', pitch === 3)
    await rig.finish(0)
    await rig.converge(0, 'completed walk')
  }
  const scroll = await b.page!.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    const bounds = el.getBoundingClientRect()
    return {
      height: el.clientHeight,
      content: el.scrollHeight,
      top: el.scrollTop,
      x: bounds.x + bounds.width / 2,
      y: bounds.y
    }
  })
  assert(scroll.height >= 100 && scroll.height <= 140)
  assert(scroll.content > scroll.height)
  // Maestro's desktop swipe is a mouse drag, not a touch-scroll gesture.
  // Exercise keyboard scrolling here; Safari verifies the touch gesture.
  await b.m.tapOn({ css: '[data-testid="remote-scoring-update-lines"]' })
  await b.m.pressKey({ key: 'PAGE_UP' })
  await new Promise(resolve => setTimeout(resolve, 500))
  const scrolledTop = await b.page!.evaluate(() => {
    return document.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!.scrollTop
  })
  assert(scrolledTop < scroll.top, 'Scrolling upward must reveal older text')
  await b.m.assertVisible({ text: 'Follow latest scoring updates' })
  const widthBefore = await b.page!.evaluate(
    () =>
      document
        .querySelector<HTMLElement>(
          '[data-testid="remote-scoring-update-lines"]'
        )!
        .firstElementChild!.getBoundingClientRect().width
  )
  await rig.capture('updates-paused')
  await rig.pitch(0, 'Foul Ball')
  await b.m.assertVisible({ text: 'Follow latest scoring updates' })
  await b.m.tapOn({ css: '[data-testid="remote-scoring-update-lines"]' })
  await b.m.pressKey({ key: 'END' })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(
    await b.page!.evaluate(
      () =>
        document.querySelector(
          '[aria-label="Follow latest scoring updates"]'
        ) != null
    ),
    false,
    'Manually reaching the bottom must restore following'
  )
  await rig.pitch(0, 'Foul Ball')
  const followed = await b.page!.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    return {
      bottom: el.scrollHeight - el.scrollTop - el.clientHeight,
      width: el.firstElementChild!.getBoundingClientRect().width
    }
  })
  assert(
    followed.bottom <= 2,
    'New plays must remain visible after manual resume'
  )
  assert.equal(
    followed.width,
    widthBefore,
    'The down arrow must not reflow text'
  )
  await b.m.pressKey({ key: 'PAGE_UP' })
  await b.m.tapOn({ text: 'Follow latest scoring updates' })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(
    await b.page!.evaluate(
      () =>
        document.querySelector(
          '[aria-label="Follow latest scoring updates"]'
        ) != null
    ),
    false
  )
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
  // Short viewports intentionally let the expanded stream overlap controls.
  // Collapse first, as a scorekeeper would, before opening a scoring menu.
  await rig.tap(1, '^More$')
  assert.equal(await panelText(1), '', 'The panel must yield to scoring menus')
  await b.m.assertVisible({ text: '^Intentional Walk$', timeout: 10000 })
  await b.m.pressKey({ key: 'ESCAPE' })
  await b.m.assertVisible({ css: card, timeout: 10000 })
  await rig.pitch(1, 'Ball')
  await a.m.assertVisible({ css: card, timeout: 10000 })
  saved = await rig.api.gameEvents(rig.fixture.ids.game)
  const lastScorer = lastAuthor(saved)
  assert.equal(lastScorer, rig.fixture.accounts['scorer-b'].userId)
  assert(
    (await panelText(0)).includes(saved.scoringAuthorship!.names[lastScorer])
  )
  await writeFile(
    rig.ctx.artifact('updates-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        geometry,
        scroll,
        decoratedUndoReplacement: true,
        scoringAuthorship: saved.scoringAuthorship,
        interventions: 0
      },
      null,
      2
    )
  )
}
