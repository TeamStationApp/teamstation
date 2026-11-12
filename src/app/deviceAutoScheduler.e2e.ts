// After build.web, set TS_AUTO_SCHEDULER_ARTIFACTS and the maestro-d environment.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { HTTPRequest } from 'puppeteer'

import { coversGame, effectiveAvailability } from '../common/fieldAvailability'
import type { SchedulePreview } from '../common/schedulePreviews'
import type { SeasonScheduleSettings } from '../common/seasonScheduling'
import type { VenueDetail } from '../common/venues'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  autoSchedulerFixture,
  seedThrough
} from '../test/autoSchedulerFixture'
import { googlePlacesStub } from '../test/googlePlacesStub'
import {
  browserSession,
  capture,
  contains,
  fill,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import { recordBrowserCoverage } from './browserCoverage.e2e'

async function main(): Promise<void> {
  const dir = process.env.TS_AUTO_SCHEDULER_ARTIFACTS
  if (dir == null) throw new Error('Set TS_AUTO_SCHEDULER_ARTIFACTS')
  await mkdir(dir, { recursive: true })
  const places = await googlePlacesStub()
  const fx = await autoSchedulerFixture(resolve('dist'), {
    cityLookup: googlePlaces({ apiKey: 'test', baseUrl: places.baseUrl })
  })
  const daemon = await maestro('deviceAutoScheduler')
  const b = await browserSession(
    daemon,
    'deviceAutoScheduler-web',
    402,
    874,
    dir
  )
  const lines = [
    '$ node -r sucrase/register src/app/deviceAutoScheduler.e2e.ts'
  ]
  const pass = (message: string): void => {
    lines.push(`PASS ${message}`)
    console.log(`PASS ${message}`)
  }
  const before = process.argv.includes('--before')
  try {
    const state = await seedThrough(fx, 'E7')
    await b.m.openBrowser({ url: fx.f.h.origin + '/sign-in' })
    await fill(b.m, 'E-mail address', 'alex@example.com')
    await tap(b.m, 'Send me a sign-in code')
    await contains(b.page, 'six-digit code is on its way')
    await fill(b.m, 'Sign-in code', fx.f.h.mail.get('alex@example.com')!)
    await tap(b.m, 'Sign in')
    await contains(b.page, 'Your Home')
    const scheduler = `/groups/league/${fx.f.leagueA}/scheduler`
    const constraints = `${scheduler}/seasons/${fx.f.seasonA}`
    const paths = [
      [
        'scheduler',
        scheduler,
        before ? 'SCHEDULE SETTINGS' : 'SELECT SEASONS TO AUTO SCHEDULE.'
      ],
      ['constraints', constraints, 'Max games on weekdays'],
      [
        'venue',
        `/venues/${state.venueId}`,
        before ? 'Default hours' : 'Time Windows'
      ],
      [
        'field',
        `/venues/${state.venueId}/fields/${state.fieldId}`,
        'AVAILABILITY'
      ]
    ]
    for (const [name, path, word] of paths) {
      await b.m.openBrowser({ url: fx.f.h.origin + path })
      await contains(b.page, word)
      await capture(b.m, dir, `${name}-${before ? 'before' : 'after'}.png`)
      pass(`${name} screenshot`)
    }
    if (before) return
    const label = async (name: string): Promise<void> => {
      await b.m.tapOn({ css: `[aria-label="${name}"]`, timeout: 15000 })
    }
    await b.m.openBrowser({ url: fx.f.h.origin + scheduler })
    await contains(b.page, 'SELECT SEASONS TO AUTO SCHEDULE.')
    const body = await b.page.evaluate(() => document.body.textContent)
    expect(body).not.includes('FIELDS FOR THIS RUN')
    expect(body).not.includes('SCHEDULE SETTINGS')
    expect(await b.page.$$('[data-testid="season-schedule-grid"]')).length(1)
    await label('Demo Playoffs')
    await label('Demo Playoffs')
    const rowLabels = [
      'Game length in minutes',
      'Time between games in minutes',
      'Regular-season games',
      'Exhibition games'
    ]
    await label('Demo Regular Game length in minutes: 90')
    for (const [index, value] of ['95', '15', '4', '1'].entries()) {
      await b.page.waitForSelector(
        `input[aria-label="Edit Demo Regular ${rowLabels[index]}"]`
      )
      await b.m.inputText({ text: value })
      await b.m.pressKey({ key: 'TAB' })
    }
    await b.m.pressKey({ key: 'ESCAPE' })
    pass(
      'All four numeric columns save with Tab; all season rows remain in one table.'
    )
    await b.m.tapOn({ css: '[aria-label^="Demo Regular Size:"]' })
    await tap(b.m, '50/70')
    await b.m.tapOn({ css: '[aria-label^="Demo Regular Doubleheaders:"]' })
    await tap(b.m, 'Allowed')
    await b.page.waitForSelector(
      '[aria-label="Demo Regular Doubleheaders: Allowed"]'
    )
    await b.m.openBrowser({ url: fx.f.h.origin + constraints })
    await contains(b.page, 'Season Scheduling Constraints')
    await label('Max games on weekdays: 200')
    await b.m.inputText({ text: '201' })
    await b.m.pressKey({ key: 'ENTER' })
    await contains(b.page, 'Choose a maximum from 0 to 200.')
    await b.m.tapOn({ css: 'input[aria-label="Max games on weekdays"]' })
    await b.m.pressKey({ key: 'CTRL+A' })
    await b.m.inputText({ text: '2' })
    await b.m.pressKey({ key: 'ENTER' })
    await b.page.waitForSelector('[aria-label="Max games on weekdays: 2"]')
    const path = `/seasons/${fx.f.seasonA}/schedule-settings`
    let saved = await api<SeasonScheduleSettings>(fx, 101, 'GET', path)
    expect(saved.settings.maxGamesOnWeekdays).equals(2)
    await label('Required field size 60/90')
    await contains(b.page, 'Field size saved.')
    expect(
      await b.page.$eval('[aria-label="Field 1, Example Park"]', node =>
        node.getAttribute('aria-disabled')
      )
    ).equals('true')
    await label('Required field size 50/70')
    await contains(b.page, 'Field size saved.')
    await label('Field 1, Example Park')
    await contains(b.page, 'Fields saved.')
    pass(
      'Size and doubleheader pickers persist; exclusive size switches disable incompatible fields; invalid maxima are refused.'
    )
    await label(`Field 1, Example Park`)
    await contains(b.page, 'Fields saved.')
    saved = await api<SeasonScheduleSettings>(fx, 101, 'GET', path)
    expect(saved.settings.fieldIds).not.includes(state.fieldId)
    await b.m.openBrowser({ url: fx.f.h.origin + scheduler })
    await contains(b.page, 'no chosen field')
    pass('An empty season field selection prevents scheduling.')
    await b.m.openBrowser({ url: fx.f.h.origin + constraints })
    await contains(b.page, 'Select fields to use'.toUpperCase())
    await label('Field 1, Example Park')
    await contains(b.page, 'Fields saved.')
    saved = await api<SeasonScheduleSettings>(fx, 101, 'GET', path)
    expect(saved.settings.fieldIds).includes(state.fieldId)
    await b.m.scrollUntilVisible({
      element: { css: '[aria-label="Add a field from the registry"]' },
      direction: 'DOWN'
    })
    await b.page.waitForFunction(() =>
      [...document.querySelectorAll('div')].some(
        node =>
          node.textContent === 'Season Scheduling Constraints' &&
          node.children.length === 0 &&
          node.getBoundingClientRect().top >= 0 &&
          node.getBoundingClientRect().top < 100 &&
          Number(getComputedStyle(node.parentElement!).opacity) > 0.9
      )
    )
    await capture(b.m, dir, 'constraints-header-after.png')
    await b.m.openBrowser({ url: fx.f.h.origin + constraints })
    await contains(b.page, 'Max games on weekend')
    let refuseWrite = true
    const intercept = (request: HTTPRequest): void => {
      if (
        refuseWrite &&
        request.method() === 'PUT' &&
        request.url().endsWith('/schedule-settings')
      ) {
        refuseWrite = false
        request
          .respond({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Temporarily unavailable' })
          })
          .catch(() => undefined)
      } else request.continue().catch(() => undefined)
    }
    await b.page.setRequestInterception(true)
    b.page.on('request', intercept)
    await label('Max games on weekend: 200')
    await b.m.inputText({ text: '3' })
    await b.m.pressKey({ key: 'ENTER' })
    await b.page.waitForSelector('[role="alert"]')
    expect(
      (await api<SeasonScheduleSettings>(fx, 101, 'GET', path)).settings
        .maxGamesOnWeekend
    ).equals(200)
    await b.m.tapOn({ css: 'input[aria-label="Max games on weekend"]' })
    await b.m.pressKey({ key: 'ENTER' })
    await b.page.waitForSelector('[aria-label="Max games on weekend: 3"]')
    b.page.off('request', intercept)
    await b.page.setRequestInterception(false)
    pass(
      'Constraints title hands off to the header; a failed numeric save retains its draft and retries successfully.'
    )
    await b.page.setViewport({ width: 1200, height: 900 })
    await b.m.openBrowser({ url: fx.f.h.origin + scheduler })
    await contains(b.page, 'SELECT SEASONS TO AUTO SCHEDULE.')
    await capture(b.m, dir, 'scheduler-wide.png')
    await b.page.setViewport({ width: 402, height: 874 })
    await b.m.openBrowser({ url: fx.f.h.origin + `/venues/${state.venueId}` })
    await contains(b.page, 'Time Windows')
    await tap(b.m, 'Add another time window')
    await fill(b.m, 'Year', '2027')
    await b.m.tapOn({ css: '[aria-label^="Choose month:"]' })
    await label('June')
    await label('Choose 2027-06-01')
    await tap(b.m, 'Use date')
    await contains(b.page, 'Hours saved.')
    const venueWindows = await api<VenueDetail>(
      fx,
      101,
      'GET',
      `/venues/${state.venueId}`
    )
    expect(venueWindows.defaultWindows!.map(period => period.from)).deep.equals(
      ['0001-01-01', '2027-06-01']
    )
    await b.m.openBrowser({
      url: fx.f.h.origin + `/venues/${state.venueId}/fields/${state.fieldId}`
    })
    await contains(b.page, 'Its own hours')
    await tap(b.m, 'Venue hours', 'tab')
    await contains(b.page, 'This field now uses the venue’s hours.')
    await tap(b.m, 'Its own hours', 'tab')
    await contains(b.page, 'This field now keeps its own hours.')
    const inherited = await api<VenueDetail>(
      fx,
      101,
      'GET',
      `/venues/${state.venueId}`
    )
    expect(
      inherited.fields.find(field => field.id === state.fieldId)!.windows
    ).deep.equals(venueWindows.defaultWindows)
    pass(
      'Venue date editor preserves legacy hours; field inheritance and own windows persist through the UI.'
    )
    // A dated split closes the field outside its season's retained windows.
    const venue = await api<VenueDetail>(
      fx,
      101,
      'GET',
      `/venues/${state.venueId}`
    )
    const periods = [
      {
        from: '2027-03-01',
        until: '2027-05-31',
        hours: [{ weekday: 6, start: '10:00', end: '18:00' }]
      },
      {
        from: '2027-06-01',
        hours: [{ weekday: 6, start: '12:00', end: '18:00' }]
      }
    ]
    await api(
      fx,
      101,
      'PUT',
      `/venues/${state.venueId}/fields/${state.fieldId}`,
      { windows: periods }
    )
    await b.m.openBrowser({ url: fx.f.h.origin + scheduler })
    await contains(b.page, 'Build schedule')
    const prepared = b.page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/schedule-previews') &&
        response.status() === 201
    )
    const completed = b.page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        response.url().endsWith('/result') &&
        response.status() === 200
    )
    await tap(b.m, 'Build schedule')
    await contains(b.page, 'Work around them')
    await tap(b.m, 'Work around them')
    const preparedBody = await (await prepared).json()
    expect(preparedBody).has.property('input')
    expect(preparedBody).not.has.property('options')
    const preview = (await (await completed).json()) as SchedulePreview
    expect(preview.options[0].games.length).greaterThan(0)
    const field = {
      ...venue.fields.find(field => field.id === state.fieldId)!,
      windows: periods
    }
    for (const game of preview.options[0].games) {
      expect(game.fieldId).equals(state.fieldId)
      expect(
        coversGame(
          effectiveAvailability(
            { ...venue, timezone: venue.timezone ?? 'UTC' },
            field
          ),
          game.startAt,
          game.endAt
        )
      ).equals(true)
    }
    await contains(b.page, 'Publish this option')
    const publication = b.page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/publications'),
      { timeout: 60000 }
    )
    await tap(b.m, 'Publish this option')
    expect((await publication).status()).equals(200)
    await contains(b.page, 'games scheduled')
    pass(
      `Browser computed and submitted ${preview.options[0].games.length} games; server validated, stored and published them within the selected field's dated windows.`
    )
    const coverage = process.env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE
    if (coverage != null)
      await recordBrowserCoverage([b.page], fx.f.h.origin, coverage)
  } finally {
    await writeFile(join(dir, 'device-scheduling.log'), lines.join('\n') + '\n')
    await b.browser.disconnect()
    await daemon.shutdown()
    await fx.f.h.close()
    await places.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
