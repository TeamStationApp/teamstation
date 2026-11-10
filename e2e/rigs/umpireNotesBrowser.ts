import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Page } from 'puppeteer'

import type { TeamStationClient } from '../../src/common/api'
import type { GroupFixture } from '../../src/test/groupFixtures'
import {
  capture,
  contains,
  type MaestroHandle,
  tap
} from './refinementsMaestro'

export async function exerciseUmpireNotes(
  f: GroupFixture,
  client: TeamStationClient,
  page: Page,
  m: MaestroHandle,
  artifacts: string
): Promise<void> {
  const types = await client.umpireNoteTypes(f.leagueA)
  const [color, contact] = types
  const source = await f.h.db
    .selectFrom('games')
    .selectAll()
    .where('id', '=', 'gam_umpire_g1')
    .executeTakeFirstOrThrow()
  for (const [id, date] of [
    ['gam_notes_second', '2027-04-05'],
    ['gam_notes_third', '2027-04-06']
  ])
    await f.h.db
      .insertInto('games')
      .values({
        ...source,
        id,
        start_at: new Date(date + 'T00:00:00Z'),
        end_at: new Date(date + 'T02:00:00Z')
      })
      .execute()
  await client.saveUmpireNote('gam_notes_second', color.id, '', 'Gold')
  await m.openBrowser({ url: `${f.h.origin}/umpires/${f.leagueA}?view=league` })
  const selector = (game: string, type: string, editing = false): string =>
    `[data-testid="umpire-note-${editing ? 'input-' : ''}${game}-${type}"]`
  const focus = async (
    game: string,
    type: string,
    value?: string
  ): Promise<void> => {
    await page.waitForFunction(
      (selector: string) =>
        document.activeElement === document.querySelector(selector),
      { polling: 100 },
      selector(game, type, true)
    )
    if (value != null)
      expect(
        await page.$eval(selector(game, type, true), n => [
          (n as HTMLInputElement).value,
          (n as HTMLInputElement).selectionStart,
          (n as HTMLInputElement).selectionEnd
        ])
      ).deep.equals([value, 0, value.length])
  }
  const click = async (game: string, type: string): Promise<void> => {
    await m.tapOn({ css: selector(game, type), timeout: 10000 })
    await focus(game, type)
  }
  await page.waitForSelector(selector(source.id, color.id))
  expect(await page.$('input[data-testid^="umpire-note-input-"]')).equals(null)
  await capture(m, artifacts, 'schedule-after.png')
  await click(source.id, color.id)
  await page.keyboard.type('Navy')
  await page.keyboard.press('Enter')
  await focus('gam_notes_second', color.id, 'Gold')
  await capture(m, artifacts, 'notes-editing.png')
  await page.keyboard.press('Tab')
  await focus('gam_notes_second', contact.id)
  await page.keyboard.type('Demo contact')
  await page.keyboard.press('Tab')
  await focus('gam_notes_third', color.id)
  await page.keyboard.down('Shift')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Shift')
  await focus('gam_notes_second', contact.id, 'Demo contact')
  await page.keyboard.type('Discard')
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () =>
      document.querySelector('input[data-testid^="umpire-note-input-"]') == null
  )
  await click('gam_notes_second', contact.id)
  await focus('gam_notes_second', contact.id, 'Demo contact')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await focus('gam_notes_third', contact.id)
  await page.keyboard.press('Tab')
  await page.waitForFunction(
    () =>
      document.querySelector('input[data-testid^="umpire-note-input-"]') == null
  )

  // A network failure preserves the draft and focus; retry sends one write.
  let fail = true
  let writes = 0
  await page.setRequestInterception(true)
  page.on('request', req => {
    if (req.method() === 'PUT' && req.url().includes('/umpire-notes/')) {
      writes++
      if (fail) {
        req
          .respond({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'internal',
              message: 'Simulated note failure'
            })
          })
          .catch(() => undefined)
        return
      }
    }
    req.continue().catch(() => undefined)
  })
  await click(source.id, contact.id)
  await page.keyboard.type('At entrance')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    document.body.textContent!.includes('Simulated note failure')
  )
  await focus(source.id, contact.id)
  expect(
    await page.$eval(
      selector(source.id, contact.id, true),
      n => (n as HTMLInputElement).value
    )
  ).equals('At entrance')
  fail = false
  await page.keyboard.press('Enter')
  await focus('gam_notes_second', contact.id)
  expect(writes).equals(2)
  await page.keyboard.press('Escape')

  // Editing a failed draft makes ordinary click-away autosave available again.
  await click(source.id, contact.id)
  await page.keyboard.type('Second attempt')
  fail = true
  await page.keyboard.press('Enter')
  await contains(page, 'Simulated note failure')
  await focus(source.id, contact.id)
  fail = false
  await page.$eval(selector(source.id, contact.id, true), n => {
    ;(n as HTMLInputElement).select()
  })
  await page.keyboard.type('Revised entrance')
  await page.mouse.click(720, 80) // Blank heading margin, not a navigation action.
  await page.waitForSelector(selector(source.id, contact.id))
  expect(
    await page.$eval(selector(source.id, contact.id), n => n.textContent)
  ).equals('Revised entrance')
  expect(writes).equals(4)

  // Real optimistic conflict, then cancel rather than overwrite the other edit.
  await click(source.id, color.id)
  await page.keyboard.type('Red')
  await client.saveUmpireNote(source.id, color.id, 'Navy', 'Green')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    document.body.textContent!.includes('This note changed')
  )
  await focus(source.id, color.id)
  expect(
    await page.$eval(
      selector(source.id, color.id, true),
      n => (n as HTMLInputElement).value
    )
  ).equals('Red')
  await tap(m, 'Discard note changes')
  await page.waitForSelector(selector(source.id, color.id))
  expect(
    await page.$eval(selector(source.id, color.id), n => n.textContent)
  ).equals('Green')
  await tap(m, 'Schedule filters')
  await contains(page, 'Apply filters')
  await tap(m, 'Cancel')
  await click(source.id, color.id)
  await page.keyboard.type('White')
  await page.$eval(selector(source.id, color.id, true), n =>
    n.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true
      })
    )
  )
  await focus(source.id, color.id)
  await m.tapOn({ css: selector(source.id, contact.id) })
  await focus(source.id, contact.id, 'Revised entrance')
  // Filter opening commits the current cell before replacing the grid.
  await page.keyboard.type('Gate A')
  await tap(m, 'Schedule filters')
  await contains(page, 'Apply filters')
  await tap(m, 'Cancel')
  await page.reload()
  await page.waitForSelector(selector(source.id, contact.id))
  expect(
    await page.$eval(selector(source.id, contact.id), n => n.textContent)
  ).equals('Gate A')
  expect(
    await page.$eval(selector(source.id, color.id), n => n.textContent)
  ).equals('White')
  expect(
    await page.$eval(
      selector('gam_notes_second', contact.id),
      n => n.textContent
    )
  ).equals('')
  expect(
    (await client.umpireSchedule(f.leagueA, 'view=league')).games.find(
      g => g.id === source.id
    )!.notes
  ).equals('North diamond entrance')
  // History and external navigation must hold a failed draft on this screen.
  await tap(m, 'Schedule filters')
  await tap(m, 'Saturday')
  await tap(m, 'Apply filters')
  await click(source.id, color.id)
  await page.keyboard.type('History saved')
  fail = true
  await page.evaluate(() => {
    window.history.back()
  })
  await contains(page, 'Simulated note failure')
  await focus(source.id, color.id)
  expect(new URL(page.url()).searchParams.get('days')).equals('5')
  fail = false
  await page.evaluate(() => {
    window.history.back()
  })
  await page.waitForFunction(
    () => !new URL(location.href).searchParams.has('days'),
    { polling: 100 }
  )
  await click(source.id, color.id)
  await page.keyboard.type('Link saved')
  fail = true
  await page.$eval('[aria-label="Open Demo Hawks"]', n => {
    n.scrollIntoView({ block: 'center', inline: 'center' })
  })
  await tap(m, 'Open Demo Hawks', 'link')
  await contains(page, 'Simulated note failure')
  await focus(source.id, color.id)
  expect(new URL(page.url()).pathname).contains('/umpires/')
  fail = false
  await page.$eval('[aria-label="Open Demo Hawks"]', n => {
    n.scrollIntoView({ block: 'center', inline: 'center' })
  })
  await tap(m, 'Open Demo Hawks', 'link')
  await page.waitForFunction(() => location.pathname.startsWith('/teams/'), {
    polling: 100
  })
  expect(
    (await client.umpireSchedule(f.leagueA, 'view=league')).games.find(
      g => g.id === source.id
    )!.umpireNotes[color.id]
  ).equals('Link saved')
  await m.openBrowser({ url: `${f.h.origin}/umpires/${f.leagueA}?view=league` })
  await page.setViewport({ width: 390, height: 844 })
  await click(source.id, color.id)
  await capture(m, artifacts, 'support/notes-narrow.png')
  await page.keyboard.press('Escape')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).equals(true)
  await page.setViewport({ width: 1440, height: 900 })
  await writeFile(
    join(artifacts, 'keyboard.log'),
    '$ node -r sucrase/register src/app/umpireConfigurable.e2e.ts\nPASS: Enter down and selection, Tab right/wrap, Shift+Tab reverse, boundary exit, Escape, blank clear, failure/retry and edited-draft click-away autosave, optimistic conflict with touch-accessible discard and refresh, blur/click, composing Enter, filters, browser history and team navigation guarded on failed saves, persistence, narrow viewport.\n'
  )
}
