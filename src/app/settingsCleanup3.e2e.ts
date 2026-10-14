/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Serialized browser callbacks cannot capture compiler helpers. */
import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { TeamStationClient } from '../common/api'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { googlePlaces } from '../server/location/googlePlaces'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { groupFixture } from '../test/groupFixtures'
import {
  browserSession,
  contains,
  fill,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import { seedSettingsCleanup3 } from '../test/settingsCleanup3Fixture'
import { freezeBrowserClock } from './creationBrowserActions.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_CREATION_ARTIFACTS')
const before = process.argv.includes('--base')
const phase = before ? 'before' : 'after'
const only = process.env.TS_SETTINGS3_SCENARIO

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const stub = await googlePlacesStub()
  const f = await groupFixture(
    resolve(process.env.TS_SETTINGS3_WEB_ROOT ?? 'dist'),
    undefined,
    undefined,
    googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
  )
  const daemon = await maestro(`settings3-${phase}-${process.pid}`)
  const { m, page, browser } = await browserSession(
    daemon,
    `settings3-${phase}-${process.pid}`,
    402,
    874,
    artifacts!,
    'chrome'
  )
  const note = async (line: string): Promise<void> => {
    console.log(line)
    await appendFile(join(artifacts!, 'settings-cleanup3-e2e.log'), line + '\n')
  }
  const go = async (path: string, text: string): Promise<void> => {
    await m.openLink({ link: f.h.origin + path })
    await contains(page, text)
    await page.waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
  }
  const shot = async (name: string): Promise<void> => {
    // Live indicators animate continuously; each route's loaded state is
    // asserted before capturing rather than waiting for the entire DOM to stop.
    await writeFile(
      join(artifacts!, `${name}-${phase}.png`),
      await m.screenshot()
    )
    await note(`Captured ${name}-${phase}.png`)
  }
  const show = async (text: string): Promise<void> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const position = await page.evaluate(text => {
        const node = [...document.querySelectorAll<HTMLElement>('*')].find(
          node =>
            node.getAttribute('aria-label') === text ||
            (node.children.length === 0 && node.textContent === text)
        )
        if (node == null) throw new Error('Missing scroll target: ' + text)
        const box = node.getBoundingClientRect()
        return { y: box.y + box.height / 2, height: innerHeight }
      }, text)
      if (position.y > 90 && position.y < position.height - 100) return
      await m.command('scroll', {
        direction: position.y > position.height - 100 ? 'down' : 'up'
      })
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await writeFile(
      join(artifacts!, 'support/scroll-failure.png'),
      await m.screenshot()
    )
    const positions = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('*')]
        .filter(
          node =>
            node.scrollHeight > node.clientHeight + 20 &&
            node.clientHeight > 100
        )
        .map(node => ({
          tag: node.tagName,
          scroll: node.scrollTop,
          height: node.clientHeight,
          total: node.scrollHeight
        }))
    )
    throw new Error(
      'Scroll target remained outside usable viewport: ' +
        text +
        ' ' +
        JSON.stringify(positions)
    )
  }
  try {
    await note(
      `$ node -r sucrase/register src/app/settingsCleanup3.e2e.ts ${before ? '--base' : ''}`
    )
    await seedSettingsCleanup3(f)
    await freezeBrowserClock(page, Date.parse('2027-04-10T17:00:00Z'))
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 1,
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
    const settings = `/groups/team/${f.teamA}/settings`
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
    if (only == null || only === 'overview') {
      await go(settings, 'TEAM DETAILS')
      await show('Winter Weekends')
      await shot('season-participations')
      if (before) await shot('leave-season')
      else {
        await tap(m, 'Leave season Winter Weekends')
        await contains(page, 'Leave Winter Weekends?')
        await shot('leave-season')
        await tap(m, 'Cancel')
        const beforeParents = (await api.group({ kind: 'team', id: f.teamA }))
          .parents
        assert.equal(
          (
            await f.h.db
              .selectFrom('season_teams')
              .select('active')
              .where('team_id', '=', f.teamA)
              .where('season_id', '=', f.seasonA)
              .executeTakeFirstOrThrow()
          ).active,
          true
        )
        await tap(m, 'Leave season Winter Weekends')
        await m.tapOn({
          css: '[data-testid="confirm-season-departure"]',
          timeout: 15000
        })
        await page.waitForFunction(
          () =>
            document.querySelector(
              '[aria-label="Leave season Winter Weekends"]'
            ) == null
        )
        const updated = await api.group({ kind: 'team', id: f.teamA })
        assert.deepEqual(updated.parents, beforeParents)
        assert(
          updated.participatingSeasons.some(season => season.id === f.playoffs)
        )
        assert.equal(
          (
            await f.h.db
              .selectFrom('games')
              .select('status')
              .where('id', '=', 'gam_settings3_scheduled')
              .executeTakeFirstOrThrow()
          ).status,
          'scheduled'
        )
        await note(
          'E1 PASS: canceled and confirmed departure; other season, parents and scheduled game preserved'
        )
        // Other scenarios start from the same fictional membership as their
        // before captures, independently of the departure mutation above.
        await f.h.db
          .updateTable('season_teams')
          .set({ active: true })
          .where('team_id', '=', f.teamA)
          .where('season_id', '=', f.seasonA)
          .execute()
      }
      for (const [name, path, text] of [
        ['team-gear', `/groups/team/${f.teamA}`, 'Winter Wolves'],
        ['league-gear', `/groups/league/${f.leagueA}`, 'Willow Woods'],
        ['season-gear', `/groups/season/${f.seasonA}`, 'Winter Weekends'],
        ['game-live-gear', '/games/gam_settings3_live?tab=info', 'Demo Field'],
        [
          'game-final-gear',
          '/games/gam_settings3_final?tab=info',
          'Demo Field'
        ],
        ['player-gear', `/players/104?onTeam=${f.teamA}`, 'Ichiro'],
        [
          'player-team-tiles',
          `/players/104?onTeam=${f.teamA}&tab=teams`,
          'Winter Wolves'
        ],
        ['home-team-tiles', '/', 'Winter Wolves'],
        ['discovery-team-tiles', '/discover?kind=team', 'Discover'],
        [
          'standings-team-tiles',
          `/groups/season/${f.seasonA}?tab=standings`,
          'Winter Weekends'
        ],
        ['team-settings-tile', settings, 'TEAM DETAILS']
      ]) {
        await go(path, text)
        if (name === 'discovery-team-tiles') {
          await fill(m, 'Search by name or city', 'Winter')
          await contains(page, 'Winter Wolves')
        }
        await shot(name)
        if (!before && name.endsWith('-gear')) {
          const label = name.startsWith('game-')
            ? 'Event settings'
            : name.startsWith('team-')
              ? 'Manage'
              : name.startsWith('league-')
                ? 'League settings'
                : name.startsWith('season-')
                  ? 'Season settings'
                  : 'Player settings'
          await page.waitForSelector(`[aria-label="${label}"]`)
          const metrics = await page.$eval(`[aria-label="${label}"]`, node => {
            const box = node.getBoundingClientRect()
            return { width: box.width, height: box.height }
          })
          assert(
            metrics.width >= 48 && metrics.height >= 48,
            label + ' full touch target'
          )
          assert.equal(
            await page.$('[role="tab"][aria-label="Settings"]'),
            null
          )
          await tap(m, label)
          await contains(
            page,
            name === 'player-gear'
              ? 'FIRST NAME'
              : name.startsWith('game-')
                ? 'Game Settings'
                : 'DETAILS'
          )
          await note(
            `${name} PASS: hero gear opens authorized settings; no Settings pill`
          )
        }
      }
    }
    if (only === 'events') {
      await go('/games/tev_settings3_other?tab=info', 'Team meeting')
      await shot('event-gear')
      await go('/games/tev_settings3_practice?tab=info', 'Practice')
      await shot('practice-gear')
    }
    if (only === 'invite') {
      await go(settings + '/invites', 'Create invite link')
      await tap(m, 'Create invite link')
      await contains(page, 'INVITE CODE')
      await shot('cancel-invite-link')
    }
    if (only == null || only === 'schedule') {
      await go(`/groups/team/${f.teamA}?tab=schedule`, 'Add Event')
      await show('Add Event')
      await shot('add-event')
    }
    if (only == null || only === 'forms') {
      await go(`/groups/team/${f.teamA}/create-game`, 'Choose Away Team')
      await show('Choose Away Team, Away')
      await m.tapOn({
        css: '[aria-label^="Choose Away Team,"]',
        timeout: 15000
      })
      await contains(page, 'Create Placeholder Team')
      await fill(m, 'Search all teams', 'Orchard')
      await contains(page, 'Orchard Owls')
      await shot('team-picker-create')
      await tap(m, 'Cancel team selector')
      await go('/games/gam_settings3_scheduled/settings', 'Game Settings')
      await show('Winter Wolves, Home')
      await tap(m, 'Winter Wolves, Home')
      await contains(page, 'Create Placeholder Team')
      await shot('team-picker-edit')
      await tap(m, 'Cancel team selector')
      await go(settings, 'TEAM DETAILS')
      await show('Remove Ichiro')
      await tap(m, 'Remove Ichiro')
      await contains(page, 'Remove Ichiro from Winter Wolves?')
      await shot('cancel-manage-player')
      await tap(m, 'Cancel')
      await go(
        `/players/104?onTeam=${f.teamA}&tab=settings`,
        'Remove from Winter Wolves'
      )
      await show('Remove from Winter Wolves')
      await tap(m, 'Remove from Winter Wolves')
      await contains(page, 'Remove Ichiro from Winter Wolves?')
      await shot('cancel-player-page')
      await tap(m, 'Cancel')
      await go('/node', 'Node administration')
      await fill(m, 'Find an account', 'fixture106')
      await contains(page, 'Tim Raines')
      await tap(m, 'Add Tim Raines')
      await page.waitForSelector('[aria-label="Revoke Tim Raines"]')
      await tap(m, 'Revoke Tim Raines')
      await contains(page, 'Revoke node access for Tim Raines?')
      await shot('cancel-revoke')
      await tap(m, 'Cancel')
      await go(settings, 'TEAM DETAILS')
      await tap(m, 'Add picture')
      await contains(page, 'Save photo')
      await shot('cancel-photo')
      await tap(m, 'Cancel')
      await go(settings + '/people', 'Add People')
      await shot('cancel-add-people')
      await go(settings + '/invites', 'Create invite link')
      await tap(m, 'Create invite link')
      await contains(page, 'INVITE CODE')
      await shot('cancel-invite-link')
    }
    if (only == null || only === 'preview') {
      for (const kind of ['team', 'season', 'league'] as const) {
        const noun = kind[0].toUpperCase() + kind.slice(1)
        const parent =
          kind === 'team' ? `?parentKind=season&parentId=${f.seasonA}` : ''
        await go(`/create/${kind}${parent}`, `Create ${noun}`)
        await fill(m, `${noun} name`, 'Winter Wolves')
        await tap(m, 'Continue')
        if (kind === 'season') {
          const label = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[role="button"]')]
              .map(node => {
                const label = node.getAttribute('aria-label')
                return label == null
                  ? node.textContent == null
                    ? ''
                    : node.textContent
                  : label
              })
              .find(text => /^(Spring|Summer|Fall|Winter) 20/.test(text))
          )
          assert(label != null, 'season preset exists')
          await tap(m, label)
        } else {
          if (
            (await page.$('[aria-label="Location not set, Add a city"]')) !=
            null
          ) {
            await tap(m, 'Location not set, Add a city')
            await fill(m, 'City', 'tor')
            await m.tapOn({
              css: '[aria-label^="Choose Toronto,"]',
              timeout: 10000
            })
            await tap(m, 'Save')
          }
        }
        await tap(m, 'Continue')
        await tap(m, 'Use initials')
        await shot(`${kind}-wide-initials`)
        if (kind === 'team') await shot('team-initials-preview')
        if (kind === 'season') {
          await tap(m, 'Previous step')
          await tap(m, 'Previous step')
          await fill(m, 'Season name', 'W')
          await tap(m, 'Continue')
          await tap(m, 'Continue')
          await tap(m, 'Use initials')
          await shot('single-initial-preview')
        }
      }
    }
    await note(`${phase}: baseline/UI tour completed`)
  } finally {
    // A failed driver command must not leave the fixture or owned daemon alive.
    await Promise.allSettled([m.detach(), browser.disconnect()])
    await Promise.allSettled([daemon.shutdown(), f.h.close(), stub.close()])
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
