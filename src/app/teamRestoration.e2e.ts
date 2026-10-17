import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import {
  absent,
  type BrowserSession,
  browserSession,
  capture,
  contains,
  diagnostic,
  fill,
  log,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import { refinementsFixture } from '../test/seasonGameRefinementsFixture'
import { recordBrowserCoverage } from './browserCoverage.e2e'

/** Finished follow-up, with genuine HTTP routes and isolated synthetic data. */
async function main(): Promise<void> {
  const artifacts = process.env.TS_REFINEMENTS_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_REFINEMENTS_ARTIFACTS')
  await mkdir(join(artifacts, 'support'), { recursive: true })
  const seed = await refinementsFixture(resolve('dist'))
  const { f } = seed
  const daemon = await maestro(
    process.env.MAESTRO_D ?? 'teamRestorationBrowser'
  )
  const sessions: BrowserSession[] = []
  await writeFile(
    join(artifacts, 'browser-qa.log'),
    '$ node -r sucrase/register src/app/teamRestoration.e2e.ts\n'
  )
  const pass = async (text: string): Promise<void> => {
    await log(artifacts, 'browser-qa.log', text + ' PASS')
  }
  const make = async (
    name: string,
    width: number,
    height: number,
    login: boolean
  ): Promise<BrowserSession> => {
    const b = await browserSession(
      daemon,
      `${name}-${process.pid}`,
      width,
      height,
      artifacts
    )
    sessions.push(b)
    if (login) {
      await b.m.openBrowser({ url: f.h.origin + '/sign-in' })
      await fill(b.m, 'E-mail address', 'alex@example.com')
      await tap(b.m, 'Send me a sign-in code')
      await contains(b.page, 'six-digit code')
      await fill(b.m, 'Sign-in code', f.h.mail.get('alex@example.com')!)
      await tap(b.m, 'Sign in')
      await contains(b.page, 'YOUR TEAMS')
    }
    return b
  }
  try {
    const b = await make('restore-wide', 1440, 1000, true)
    const recentResponse = await f.h.request(
      'GET',
      '/events?played=1&limit=1',
      undefined,
      101
    )
    const recentRows = await recentResponse.json()
    expect(recentRows).length(1)
    await b.page.setRequestInterception(true)
    b.page.on('request', request => {
      if (
        new URL(request.url()).pathname === '/api/v1/events' &&
        new URL(request.url()).searchParams.get('played') === '1'
      ) {
        request
          .respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{ ...recentRows[0], videoCount: 1 }])
          })
          .catch(() => undefined)
      } else request.continue().catch(() => undefined)
    })
    for (const width of [360, 375]) {
      await b.page.setViewport({ width, height: 874 })
      await b.m.openBrowser({ url: f.h.origin })
      await contains(b.page, 'Box Score')
      await b.page.evaluate(async () => await document.fonts.ready)
      const labels = await diagnostic(b.page, () =>
        [...document.querySelectorAll<HTMLElement>('[role="button"]')]
          .filter(
            node =>
              node.textContent !== null &&
              /(?:Watch|Box Score)$/.test(node.textContent)
          )
          .map(node => {
            const label = [...node.querySelectorAll<HTMLElement>('*')].find(
              child =>
                child.children.length === 0 &&
                (child.textContent === 'Watch' ||
                  child.textContent === 'Box Score')
            )!
            const range = document.createRange()
            range.selectNodeContents(label)
            return {
              label: label.textContent,
              text: range.getBoundingClientRect().width,
              available: label.getBoundingClientRect().width,
              button: node.getBoundingClientRect().toJSON()
            }
          })
      )
      expect(labels).length(2)
      for (const label of labels) {
        expect(label.text, `${width}px ${label.label}`).at.most(
          label.available + 1
        )
        expect(label.button.left).at.least(0)
        expect(label.button.right).at.most(width)
      }
      await capture(b.m, artifacts, `home-pills-${width}.png`)
    }
    await b.page.setRequestInterception(false)
    b.page.removeAllListeners('request')
    await b.page.setViewport({ width: 1440, height: 1000 })
    await b.m.openBrowser({ url: f.h.origin })
    await pass(
      'Home Watch and Box Score retain complete labels at 360 and 375 pixels with bundled fonts'
    )
    const visit = async (path: string): Promise<void> => {
      await b.m.openBrowser({ url: f.h.origin + path })
    }
    const shell = async (): Promise<void> => {
      await b.page.waitForSelector('[aria-label="Team sections"]', {
        timeout: 15000
      })
      await contains(b.page, 'Demo Hawks')
      await b.page.waitForFunction(() => {
        const text = document.body.textContent
        if (text === null) return true
        return !text.includes('Loading…')
      })
      const tabs = await diagnostic(b.page, () =>
        [
          ...document.querySelectorAll(
            '[aria-label="Team sections"] [role="tab"]'
          )
        ].map(n => n.textContent)
      )
      expect(tabs).deep.equals(['Videos', 'Schedule', 'Team', 'Stats'])
      await absent(b.page, 'Open team videos and stats')
      await absent(b.page, 'Create Game')
    }
    await capture(b.m, artifacts, 'home-nav-after.png')
    await tap(b.m, 'Demo Hawks, Demo Regular · 2–1–1')
    await shell()
    await capture(b.m, artifacts, 'team-home-after.png')
    for (const tab of ['Schedule', 'Team', 'Stats', 'Videos']) {
      await tap(b.m, tab, 'tab')
      await shell()
    }
    await tap(b.m, 'Schedule', 'tab')
    await tap(b.m, 'Manage')
    await contains(b.page, 'TEAM MANAGEMENT')
    await capture(b.m, artifacts, 'team-settings-after.png')
    await b.m.command('back')
    await contains(b.page, 'SCHEDULE')
    // Maestro has Back but no Forward command. Drive the browser's own
    // history through its documented browser-script command.
    await b.m.command('evalBrowserScript', {
      script: 'window.history.forward()'
    })
    await contains(b.page, 'TEAM MANAGEMENT')
    await b.m.command('back')
    await shell()
    expect(b.page.url()).includes('tab=schedule')
    await contains(b.page, 'SCHEDULE')
    await tap(b.m, 'Manage')
    await contains(b.page, 'TEAM MANAGEMENT')
    for (const label of [
      'Add Person to Team',
      'Create Invite Link',
      'Demo City, Demo Region, US'
    ]) {
      await tap(b.m, label)
      expect(
        await diagnostic(b.page, () => document.body.textContent)
      ).not.equals('')
      const childAddress = b.page.url()
      await b.m.openBrowser({ url: childAddress })
      await contains(
        b.page,
        label === 'Add Person to Team'
          ? 'Send invite'
          : label === 'Create Invite Link'
            ? 'Invite Spectators'
            : 'City'
      )
      await b.m.command('back')
      await contains(b.page, 'TEAM MANAGEMENT')
    }
    await fill(b.m, 'Name', 'Demo Canceled Edit')
    await b.m.command('back')
    await shell()
    await contains(b.page, 'SCHEDULE')
    await absent(b.page, 'Demo Canceled Edit')
    await tap(b.m, 'Manage')
    await fill(b.m, 'Name', 'Demo Renamed Hawks')
    await b.m.tapOn({
      css: '[aria-label="Add picture"], [aria-label="Change picture"]'
    })
    await tap(b.m, 'Use initials')
    await tap(b.m, 'Save photo')
    await tap(b.m, 'Save name')
    await contains(b.page, 'Name saved')
    await b.m.command('back')
    await b.page.waitForSelector('[aria-label="Team sections"]', {
      timeout: 15000
    })
    await contains(b.page, 'Demo Renamed Hawks')
    expect(b.page.url()).includes('tab=schedule')
    const renamed = await f.h.request(
      'GET',
      `/teams/${f.teamA}/public`,
      undefined,
      101
    )
    expect(renamed.status).equals(200)
    await tap(b.m, 'Manage')
    await fill(b.m, 'Name', 'Demo Hawks')
    await tap(b.m, 'Save name')
    await contains(b.page, 'Name saved')
    await b.m.command('back')
    await shell()
    await pass(
      'B2/B5 four tabs, routed people actions, Back without mutation, individual name save and same-tab return'
    )
    for (const path of [
      `/teams/${f.teamA}`,
      `/groups/team/${f.teamA}`,
      `/teams/${f.teamA}?tab=roster`,
      `/teams/${f.teamA}?tab=invalid`
    ]) {
      await visit(path)
      await shell()
    }
    await visit(`/groups/season/${f.seasonA}?tab=teams`)
    await b.m.scrollUntilVisible({
      element: { css: '[aria-label="Open Demo Hawks"]' },
      centerElement: true,
      timeout: 15000
    })
    await tap(b.m, 'Open Demo Hawks')
    await shell()
    await visit(`/groups/season/${f.seasonA}`)
    await tap(b.m, 'Open Demo Hawks')
    await shell()
    await visit(`/groups/league/${f.leagueA}`)
    await tap(b.m, 'Teams', 'tab')
    await tap(b.m, 'Open Demo Hawks')
    await shell()
    await visit('/discover')
    await fill(b.m, 'Search by name or city', 'Demo Hawks')
    await tap(b.m, 'Open Demo Hawks, Demo City, Demo Region, US')
    await shell()
    await pass(
      'B3 Home, season Teams/standings, league children, Search and private/group/legacy-tab addresses'
    )
    await visit(`/groups/season/${f.seasonA}`)
    await contains(b.page, 'PH means placeholder team.')
    await capture(b.m, artifacts, 'season-tabs-after.png')
    await capture(b.m, artifacts, 'standings-ph-after.png')
    expect(
      await diagnostic(
        b.page,
        () =>
          document.querySelectorAll('[aria-label="Placeholder team"]').length
      )
    ).equals(1)
    const frozen = await diagnostic(
      b.page,
      () =>
        document
          .querySelector('[aria-label="Open Demo Foxes"]')!
          .getBoundingClientRect().x
    )
    await tap(b.m, 'Include Exhibitions', 'tab')
    await contains(b.page, '.625')
    expect(
      await diagnostic(
        b.page,
        () =>
          document
            .querySelector('[aria-label="Open Demo Foxes"]')!
            .getBoundingClientRect().x
      )
    ).equals(frozen)
    await pass(
      'B1 PH identity/key in both filters and stable frozen name column'
    )
    const v = await make('restore-public', 1440, 1000, false)
    const requests: string[] = []
    v.page.on('request', r => requests.push(r.url()))
    await v.m.openBrowser({ url: f.h.origin + `/groups/team/${f.teamA}` })
    await contains(v.page, 'membership is required')
    await capture(v.m, artifacts, 'public-team-after.png')
    await capture(v.m, artifacts, 'public-team-videos-after.png')
    await tap(v.m, 'Schedule', 'tab')
    await contains(v.page, 'SCHEDULE AND RESULTS')
    await capture(v.m, artifacts, 'public-team-schedule-after.png')
    await tap(v.m, 'Team', 'tab')
    await contains(v.page, 'STAFF AND COACHES')
    await capture(v.m, artifacts, 'public-team-directory-after.png')
    await tap(v.m, 'Stats', 'tab')
    await contains(v.page, 'membership is required')
    await capture(v.m, artifacts, 'public-team-stats-after.png')
    expect(
      requests.filter(url =>
        /\/teams\/[^/]+\/(games|stats|roster|pitching)/.test(url)
      )
    ).deep.equals([])
    await v.m.openBrowser({ url: f.h.origin + `/teams/${f.teamA}?tab=team` })
    await contains(v.page, 'TEAM INFORMATION')
    await v.m.openBrowser({
      url: f.h.origin + `/groups/team/${seed.teams.Foxes}`
    })
    await contains(v.page, 'membership is required')
    await absent(v.page, 'Manage')
    await pass(
      'B4 public and placeholder shell, public private-route compatibility, no private HTTP collections'
    )
    const mobile = await make('restore-narrow', 390, 844, true)
    await tap(mobile.m, 'Demo Hawks, Demo Regular · 2–1–1')
    await contains(mobile.page, 'GAME VIDEO LIBRARY')
    await tap(mobile.m, 'Schedule', 'tab')
    await contains(mobile.page, 'Pending approval')
    await pass(
      'B10 finished narrow browser hero/tabs and pending schedule regression'
    )
    await visit('/')
    await tap(b.m, 'Create Team')
    await fill(b.m, 'Team name', 'Demo Created Team')
    await tap(b.m, 'Continue')
    await tap(b.m, 'Location not set, Add a city')
    await fill(b.m, 'City', 'Austin')
    await b.m.tapOn({ css: '[aria-label^="Choose Austin,"]', timeout: 15000 })
    await contains(b.page, 'Save to use Austin')
    await tap(b.m, 'Save')
    await contains(b.page, 'Austin, Texas')
    await tap(b.m, 'Continue')
    await tap(b.m, 'Use initials')
    await tap(b.m, 'Continue')
    await tap(b.m, 'Create Team')
    await contains(b.page, 'Demo Created Team')
    await b.page.waitForSelector('[aria-label="Team sections"]')
    expect(
      await diagnostic(b.page, () =>
        [
          ...document.querySelectorAll(
            '[aria-label="Team sections"] [role="tab"]'
          )
        ].map(n => n.textContent)
      )
    ).deep.equals(['Videos', 'Schedule', 'Team', 'Stats'])
    await absent(b.page, 'Open team videos and stats')
    await absent(b.page, 'Create Game')
    await pass(
      'B3 creation completion enters the restored team presentation directly'
    )
    await visit(`/teams/${f.teamA}?tab=schedule`)
    await shell()
    await contains(b.page, 'Pending approval')
    const declined = await f.h.request(
      'POST',
      `/game-requests/${seed.pendingId}/decline`,
      {},
      103
    )
    expect(declined.status).equals(200)
    await b.m.command('evalBrowserScript', {
      script: 'window.dispatchEvent(new Event("focus"))'
    })
    await b.page.waitForFunction(() => {
      const text = document.body.textContent
      return text !== null && !text.includes('Pending approval')
    })
    expect(b.page.url()).includes('tab=schedule')
    await tap(b.m, 'Manage')
    await contains(b.page, 'Delete declined entry')
    await tap(b.m, 'Open game proposal')
    await b.page.waitForFunction(
      expected => window.location.pathname === expected,
      { timeout: 15000 },
      `/notifications/${seed.pendingId}`
    )
    expect(new URL(b.page.url()).pathname).equals(
      `/notifications/${seed.pendingId}`
    )
    await contains(b.page, 'Declined')
    await b.m.command('back')
    await contains(b.page, 'Delete declined entry')
    await tap(b.m, 'Delete declined entry')
    await b.page.waitForFunction(() => {
      const text = document.body.textContent
      return text !== null && !text.includes('Delete declined entry')
    })
    const proposals = await f.h.request(
      'GET',
      `/game-requests?scopeKind=team&scopeId=${encodeURIComponent(f.teamA)}`,
      undefined,
      101
    )
    expect(await proposals.json()).deep.equals([])
    await pass(
      'B5 declined proposal management remains behind gear with canonical scope and request navigation/deletion'
    )
    await recordBrowserCoverage(
      sessions.map(s => s.page),
      f.h.origin,
      process.env.TS_REFINEMENTS_BROWSER_COVERAGE ??
        resolve('coverage/refinements/team-browser.json')
    )
  } finally {
    for (const b of sessions) {
      await b.browser.disconnect()
      await b.m.detach()
    }
    await daemon.shutdown()
    await new Promise<void>(resolve =>
      seed.nativeProxy.close(() => {
        resolve()
      })
    )
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
