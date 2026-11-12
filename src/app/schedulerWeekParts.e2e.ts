// After build.web: TS_AUTO_SCHEDULER_ARTIFACTS=<directory>
// node -r sucrase/register src/app/schedulerWeekParts.e2e.ts
// Uses TS_MAESTRO_D_CLIENT and MAESTRO_D_BIN; --before captures the base UI.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { wallInstant } from '../common/fieldAvailability'
import { gameCalendarDay } from '../common/gameTime'
import { gameWeekPart } from '../common/gameWeekPart'
import type { SchedulePreview } from '../common/schedulePreviews'
import type { SeasonScheduleSettings } from '../common/seasonScheduling'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  autoSchedulerFixture,
  SEASON_A_SETTINGS,
  seedThrough
} from '../test/autoSchedulerFixture'
import { googlePlacesStub } from '../test/googlePlacesStub'
import {
  browserSession,
  capture,
  contains,
  fill,
  maestro,
  show,
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
  const daemon = await maestro(process.env.MAESTRO_D ?? 'schedulerWeekParts')
  const b = await browserSession(
    daemon,
    'schedulerWeekParts-web',
    402,
    874,
    dir
  )
  const lines = ['$ node -r sucrase/register src/app/schedulerWeekParts.e2e.ts']
  try {
    const state = await seedThrough(fx, 'E6')
    await b.m.openBrowser({ url: fx.f.h.origin + '/sign-in' })
    await fill(b.m, 'E-mail address', 'alex@example.com')
    await tap(b.m, 'Send me a sign-in code')
    await show(b.m, '.*six-digit code is on its way.*')
    await fill(b.m, 'Sign-in code', fx.f.h.mail.get('alex@example.com')!)
    await tap(b.m, 'Sign in')
    await contains(b.page, 'Your Home')
    const screen =
      fx.f.h.origin +
      `/groups/league/${fx.f.leagueA}/scheduler/seasons/${fx.f.seasonA}`
    await b.m.openBrowser({ url: screen })
    await contains(b.page, 'BLACKOUT DAYS')
    if (process.argv.includes('--before')) {
      await capture(b.m, dir, 'season-settings-before.png')
      return
    }
    await contains(b.page, 'Max games on weekdays')
    await capture(b.m, dir, 'season-settings-after.png')
    const path = `/seasons/${fx.f.seasonA}/schedule-settings`
    const read = async (): Promise<SeasonScheduleSettings> =>
      await api(fx, 101, 'GET', path)
    expect((await read()).settings).includes({
      maxGamesOnWeekdays: 1,
      maxGamesOnWeekend: 1,
      preferGameOn: 'weekend'
    })
    const number = async (label: string, value: string): Promise<void> => {
      const css = `input[aria-label="${label}"]`
      await b.m.tapOn({ css: `[aria-label^="${label}:"]` })
      await b.m.eraseText({ characters: 3 })
      await b.m.inputText({ text: value, css })
      await b.m.tapOn({ text: 'Times are local to each field.' })
      await b.page.waitForSelector(`[aria-label="${label}: ${value}"]`)
    }
    await number('Max games on weekdays', '2')
    await number('Max games on weekend', '0')
    await tap(b.m, 'weekdays', 'tab')
    await contains(b.page, 'Game preference saved.')
    await b.m.openBrowser({ url: screen })
    await contains(b.page, 'Max games on weekdays')
    expect((await read()).settings).includes({
      maxGamesOnWeekdays: 2,
      maxGamesOnWeekend: 0,
      preferGameOn: 'weekdays'
    })
    lines.push(
      'PASS UI saves and reloads 2 weekday maximum, 0 weekend maximum, weekdays preference.'
    )
    const settings = {
      ...SEASON_A_SETTINGS,
      fieldIds: [state.fieldId],
      regularGames: 2,
      exhibitionGames: 0,
      maxGamesOnWeekdays: 1,
      maxGamesOnWeekend: 1,
      preferGameOn: 'weekend'
    }
    await api(fx, 101, 'PUT', path, settings)
    await api(fx, 101, 'PUT', `/leagues/${fx.f.leagueA}/schedule-setup`, {
      seasonIds: [fx.f.seasonA],
      fieldIds: [state.fieldId]
    })
    const build = async (): Promise<SchedulePreview> =>
      await api(fx, 101, 'POST', `/leagues/${fx.f.leagueA}/schedule-previews`, {
        mode: 'full',
        existing: 'workAround'
      })
    const preview = await build()
    expect(preview.options[0].games.length).greaterThan(0)
    const games = preview.options[0].games
    const fixed = await fx.f.h.db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'start_at'])
      .where('season_id', '=', fx.f.seasonA)
      .where('status', '!=', 'cancelled')
      .execute()
    const counts = new Map<string, number>()
    for (const game of [
      ...games.map(g => ({
        teams: [g.homeTeamId, g.awayTeamId],
        start: g.startAt
      })),
      ...fixed.map(g => ({
        teams: [g.home_team_id, g.away_team_id],
        start: g.start_at.toISOString()
      }))
    ]) {
      const day = Math.round(
        Date.parse(
          gameCalendarDay(game.start, 'America/New_York') + 'T00:00:00Z'
        ) / 86400000
      )
      const portion = gameWeekPart(day)
      for (const team of game.teams) {
        const key = team + ':' + portion.key
        counts.set(key, (counts.get(key) ?? 0) + 1)
        expect(counts.get(key), key).at.most(1)
      }
    }
    lines.push(
      `PASS generated ${games.length} games; every team stays within 1 weekday and 1 weekend game per week including existing games.`
    )
    await b.m.openBrowser({
      url:
        fx.f.h.origin +
        `/groups/league/${fx.f.leagueA}/scheduler/previews/${preview.id}`
    })
    await contains(b.page, 'Publish this option')
    const first = games[0]
    const date = gameCalendarDay(first.startAt, 'America/New_York')
    expect(
      gameWeekPart(Math.round(Date.parse(date + 'T00:00:00Z') / 86400000)).part
    ).equals('weekend')
    const start = wallInstant(date, '16:30', 'America/New_York')
    const manual = await fx.f.h.request(
      'PUT',
      `/schedule-previews/${preview.id}`,
      {
        option: 0,
        rejectedGameKeys: [],
        addedGames: [
          {
            seasonId: first.seasonId,
            homeTeamId: first.homeTeamId,
            awayTeamId: first.awayTeamId,
            exhibition: false,
            fieldId: first.fieldId,
            size: first.size,
            startAt: new Date(start).toISOString(),
            endAt: new Date(start + 90 * 60000).toISOString()
          }
        ]
      },
      101
    )
    expect(manual.status).equals(400)
    expect(await manual.text()).includes('maximum')
    lines.push(
      'PASS an added game cannot exceed a team’s weekly portion maximum.'
    )
    await api(fx, 101, 'PUT', path, {
      ...settings,
      maxGamesOnWeekdays: 0,
      maxGamesOnWeekend: 0
    })
    const rejected = await fx.f.h.request(
      'POST',
      `/schedule-previews/${preview.id}/publications`,
      { option: 0 },
      101
    )
    expect(rejected.status).equals(409)
    lines.push(
      'PASS publication rejects an old preview after both current maximums become zero.'
    )
    const blocked = await build()
    expect(blocked.options).length(0)
    lines.push(
      'PASS zero limits return no schedule instead of violating a maximum.'
    )
    await api(fx, 101, 'PUT', path, settings)
    await api(
      fx,
      101,
      'POST',
      `/schedule-previews/${preview.id}/publications`,
      { option: 0 }
    )
    lines.push('PASS restored caps allow publication.')
    const coverage = process.env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE
    if (coverage != null)
      await recordBrowserCoverage(
        [b.page],
        fx.f.h.origin,
        resolve(coverage),
        resolve('dist')
      )
    await writeFile(join(dir, 'week-parts.log'), lines.join('\n') + '\n')
    console.log(lines.join('\n'))
  } finally {
    await b.browser.disconnect()
    await b.m.detach()
    await daemon.shutdown()
    await fx.f.h.close()
    await places.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
