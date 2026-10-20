/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/prefer-optional-chain -- Serialized browser callbacks cannot capture compiler helpers. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { userIdOfGumbo } from '../common/userId'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { groupFixture } from '../test/groupFixtures'
import {
  browserSession,
  capture,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import { freezeBrowserClock } from './creationBrowserActions.e2e'

const dir = process.env.TS_CREATION_ARTIFACTS
if (dir == null) throw new Error('Supply TS_CREATION_ARTIFACTS')
interface State {
  key: string
  path: string
  file: string
  pills: Array<{
    label: string
    height: number
    width: number
    padding: number
    right: number
    truncated: boolean
    rect: { x: number; y: number; width: number; height: number }
  }>
}
async function main(): Promise<void> {
  const before = process.argv.includes('--base')
  const phase = before ? 'before' : 'after'
  const root = process.env.TS_SETTINGS_BASE_WEB_ROOT ?? resolve('dist')
  const f = await groupFixture(root)
  const daemon = await maestro(`settings-pill-${phase}-${process.pid}`)
  const { m, browser, page } = await browserSession(
    daemon,
    `settings-pill-${phase}-${process.pid}`,
    402,
    874,
    dir!
  )
  try {
    await mkdir(join(dir!, 'pill-sweep'), { recursive: true })
    await freezeBrowserClock(page)
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    })
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    await f.h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    await f.h.db
      .updateTable('teams')
      .set({
        name: 'Bluebirds',
        locality: {
          city: 'Toronto',
          region: 'Ontario',
          country: 'Canada',
          placeId: null,
          timezone: 'America/Toronto'
        }
      })
      .where('id', '=', f.teamA)
      .execute()
    await f.h.db
      .updateTable('teams')
      .set({ name: 'Owls' })
      .where('id', '=', f.teamB)
      .execute()
    await f.h.db
      .updateTable('leagues')
      .set({ name: 'Harbor League' })
      .where('id', '=', f.leagueA)
      .execute()
    await f.h.db
      .updateTable('seasons')
      .set({ name: 'Spring 2026' })
      .where('id', '=', f.seasonA)
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values(
        [103, 104, 106].map(userId => ({
          id: `mem_pill_${userId}`,
          user_id: userIdOfGumbo(userId),
          team_id: f.teamA,
          is_player: true
        }))
      )
      .execute()
    await f.h.db
      .deleteFrom('user_emails')
      .where('user_id', '=', userIdOfGumbo(103))
      .execute()
    for (let index = 0; index < 3; index++)
      await f.h.db
        .insertInto('games')
        .values({
          id: `gam_settings_fixture_${index}`,
          home_team_id: f.teamA,
          away_team_id: f.teamB,
          season_id: null,
          start_at: new Date(`2027-03-${20 + index}T19:00:00Z`),
          status: 'scheduled'
        })
        .execute()
    await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      {
        email: 'invite@example.com',
        admin: false,
        flags: [],
        idempotencyKey: 'pill-invitation'
      },
      101
    )
    const oldIds = JSON.parse(
      await readFile(join(dir!, 'support/before-fixture.json'), 'utf8')
    ) as { team: string; season: string; league: string }
    const original = JSON.parse(
      await readFile(join(dir!, 'support/pill-sweep-before.json'), 'utf8')
    ) as State[]
    const registry = original.map(state => ({
      key: state.key === 'team-people' ? 'team-team' : state.key,
      path: state.path
        .replaceAll(oldIds.team, f.teamA)
        .replaceAll(oldIds.season, f.seasonA)
        .replaceAll(oldIds.league, f.leagueA)
        .replace(/(\/teams\/[^?]+\?tab=)people$/, '$1team')
    }))
    const results: State[] = []
    registry.push(
      { key: 'player-teams', path: `/players/103?onTeam=${f.teamA}&tab=teams` },
      {
        key: 'game-box-score',
        path: '/games/gam_settings_fixture_0?tab=boxScore'
      },
      { key: 'full-scoring', path: '/games/gam_settings_fixture_0/score' },
      { key: 'group-team', path: `/groups/team/${f.teamA}` },
      ...['teams', 'standings', 'people', 'stats'].map(tab => ({
        key: `group-season-${tab}`,
        path: `/groups/season/${f.seasonA}?tab=${tab}`
      })),
      ...['seasons', 'teams', 'people'].map(tab => ({
        key: `group-league-${tab}`,
        path: `/groups/league/${f.leagueA}?tab=${tab}`
      })),
      {
        key: 'group-link',
        path: `/groups/season/${f.seasonA}/link?target=team&relationship=parent&direction=children`
      },
      { key: 'notification', path: '/notifications/fixture-unavailable' },
      {
        key: 'promotion',
        path: `/groups/team/${f.teamA}/invite-administrator`
      },
      { key: 'sign-in', path: '/sign-in' },
      { key: 'expired-sign-in-link', path: '/signin/fixture-unavailable' },
      { key: 'expired-join', path: '/i/fixture-unavailable' },
      { key: 'expired-oauth-approval', path: '/oauth/approve/fixture' },
      {
        key: 'expired-native-approval',
        path: '/oauth/native-approval/' + 'x'.repeat(43)
      }
    )
    const shot = async (key: string, path: string): Promise<void> => {
      const file = `pill-sweep/${key}-${phase}.png`
      await m.waitForAnimationToEnd()
      const pills = await page.evaluate(before => {
        const tagged = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-testid^="settings-pill-"]'
          )
        ]
        const shells = before
          ? [...document.querySelectorAll<HTMLElement>('*')].flatMap(target =>
              [target, ...(target.children as unknown as HTMLElement[])].filter(
                node => {
                  const box = node.getBoundingClientRect()
                  const css = getComputedStyle(node)
                  return (
                    box.width >= box.height &&
                    box.height >= 20 &&
                    box.height <= 48 &&
                    // Shared baseline shells; 32-point RSVP controls use
                    // their own primitives and are outside this audit.
                    [20, 21, 24, 28, 36, 44, 48].some(
                      height => Math.abs(box.height - height) < 0.5
                    ) &&
                    parseFloat(css.borderTopLeftRadius) >= box.height / 2 &&
                    parseFloat(css.paddingLeft) > 0
                  )
                }
              )
            )
          : tagged
        return [...new Set(shells)].flatMap(shell => {
          const box = shell.getBoundingClientRect()
          const css = getComputedStyle(shell)
          let ancestor: HTMLElement | null = shell
          while (ancestor != null) {
            const style = getComputedStyle(ancestor)
            if (
              parseFloat(style.opacity) <= 0.001 ||
              style.visibility === 'hidden' ||
              style.visibility === 'collapse'
            )
              return []
            ancestor = ancestor.parentElement
          }
          if (
            box.height === 0 ||
            box.bottom < 0 ||
            box.top > innerHeight ||
            shell.closest('[aria-hidden="true"]') != null
          )
            return []
          if (
            box.left < 0 ||
            box.top < 0 ||
            box.right > innerWidth ||
            box.bottom > innerHeight
          )
            return []
          const target = shell.closest('[role="button"], [role="tab"]')
          const points = [
            [box.x + box.width / 2, box.y + 2],
            [box.x + box.width / 2, box.bottom - 2],
            [box.x + 2, box.y + box.height / 2],
            [box.right - 2, box.y + box.height / 2],
            [box.x + box.width / 2, box.y + box.height / 2]
          ]
          if (
            points.some(([x, y]) => {
              const front = document.elementFromPoint(x, y)
              return (
                front == null || (!shell.contains(front) && front !== target)
              )
            })
          )
            return []
          const labels = [...shell.querySelectorAll<HTMLElement>('div')].filter(
            node => node.children.length === 0 && node.textContent !== ''
          )
          return [
            {
              label:
                shell.getAttribute('aria-label') == null
                  ? shell.textContent == null
                    ? ''
                    : shell.textContent
                  : shell.getAttribute('aria-label')!,
              height: box.height,
              width: box.width,
              padding: parseFloat(css.paddingLeft),
              right: parseFloat(css.paddingRight),
              truncated: labels.some(
                node => node.scrollWidth > node.clientWidth + 1
              ),
              rect: { x: box.x, y: box.y, width: box.width, height: box.height }
            }
          ]
        })
      }, before)
      await capture(m, dir!, file)
      if (!before)
        for (const pill of pills) {
          expect(pill.padding, `${key}: ${pill.label}`).at.least(
            pill.height / 2 - 0.1
          )
          expect(pill.right, `${key}: ${pill.label}`).at.least(
            pill.height / 2 - 0.1
          )
          expect(pill.truncated, `${key}: ${pill.label}`).equals(false)
        }
      results.push({ key, path, file, pills })
    }
    for (const state of registry) {
      await m.openLink({ link: f.h.origin + state.path })
      await page
        .waitForNetworkIdle({ idleTime: 100, timeout: 15000 })
        .catch(() => undefined)
      await shot(state.key, state.path)
    }
    for (const [id, title] of [
      ['vid_pill_left', 'Left field'],
      ['vid_pill_right', 'Right field']
    ]) {
      await f.h.db
        .insertInto('videos')
        .values({
          id,
          game_id: 'gam_settings_fixture_0',
          kind: 'program',
          title,
          storage: 'local',
          status: 'ready',
          start_at: new Date('2027-03-20T19:00:00Z'),
          start_at_source: 'manual',
          duration_sec: 600,
          num_cameras: 1,
          width: 1280,
          height: 720,
          created_at: new Date(),
          updated_at: new Date()
        })
        .execute()
    }
    await m.openLink({
      link: f.h.origin + '/games/gam_settings_fixture_0?tab=watch'
    })
    await m.tapOn({ text: 'All angles', role: 'tab', timeout: 15000 })
    await page.waitForFunction(
      () =>
        document.body.textContent != null &&
        document.body.textContent.includes('Watch')
    )
    await shot('angle-picker', '/games/gam_settings_fixture_0?tab=watch')
    await m.openLink({
      link: f.h.origin + `/groups/season/${f.seasonA}?tab=teams`
    })
    await m.tapOn({ text: 'Create team', role: 'button', timeout: 15000 })
    await shot('create-team-choice', `/groups/season/${f.seasonA}?tab=teams`)
    await tap(m, 'Cancel')
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_pill_self',
        user_id: userIdOfGumbo(101),
        team_id: f.teamA,
        is_player: false
      })
      .execute()
    await m.openLink({ link: f.h.origin + `/teams/${f.teamA}?tab=schedule` })
    await m.tapOn({ css: '[aria-label^="RSVP:"]', timeout: 15000 })
    await shot('schedule-rsvp', `/teams/${f.teamA}?tab=schedule`)
    await tap(m, 'Done')
    if (!before) {
      for (const suffix of ['location', 'people', 'invites']) {
        const path = `/groups/team/${f.teamA}/settings/${suffix}`
        await m.openLink({ link: f.h.origin + path })
        await page
          .waitForNetworkIdle({ idleTime: 100, timeout: 15000 })
          .catch(() => undefined)
        await shot(`new-${suffix}`, path)
      }
      await m.openLink({ link: f.h.origin + '/account' })
      await page.waitForSelector('[aria-label="Add photo"]')
      await tap(m, 'Add photo')
      await shot('new-picture-sheet', '/account')
      await tap(m, 'Cancel')
      await m.openLink({
        link: f.h.origin + `/groups/team/${f.teamA}/settings`
      })
      await m.scrollUntilVisible({ element: { text: 'Leave Harbor League' } })
      await tap(m, 'Leave Harbor League')
      await page.waitForSelector('[aria-label="Review relationship changes"]')
      await shot('new-leave-parent', `/groups/team/${f.teamA}/settings`)
    }
    await writeFile(
      join(dir!, `support/pill-sweep-${phase}-verified.json`),
      JSON.stringify(results, null, 2)
    )
    await appendFile(
      join(dir!, 'pill-sweep.log'),
      `$ settingsPillSweep.e2e.ts ${before ? '--base (immutable base bundle)' : '--after'}\n` +
        results.map(row => JSON.stringify(row)).join('\n') +
        '\n'
    )
    console.log(
      `${phase} sweep: ${results.length} states, ${results.reduce((count, row) => count + row.pills.length, 0)} visible shared pills checked`
    )
  } finally {
    if (!before)
      await recordBrowserCoverage(
        [page],
        f.h.origin,
        resolve('coverage/creation/settings-sweep-browser.json')
      )
    await m.detach()
    await browser.disconnect()
    await daemon.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
