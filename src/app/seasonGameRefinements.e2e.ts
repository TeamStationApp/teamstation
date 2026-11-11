/* eslint-disable @typescript-eslint/prefer-optional-chain, @typescript-eslint/prefer-nullish-coalescing -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { expect } from 'chai'
import { sql } from 'kysely'

import { recordBrowserCoverage } from '../../e2e/rigs/browserCoverage'
import {
  absent,
  type BrowserSession,
  browserSession,
  capture,
  chooseDate,
  chooseTime,
  chooseTimezone,
  contains,
  diagnostic,
  fill,
  log,
  maestro,
  show,
  tap
} from '../../e2e/rigs/refinementsMaestro'
import { userIdOfGumbo } from '../common/userId'
import { gameVersion, materialGame } from '../server/schedule/gameApprovals'
import { refinementsFixture } from '../test/seasonGameRefinementsFixture'

/**
 * Setup: run npm run build.web, then set TS_REFINEMENTS_ARTIFACTS to a private
 * output directory, TS_MAESTRO_D_CLIENT to the built Maestro D JS entry, and
 * MAESTRO_D_BIN to its binary. This script starts and stops its own daemon.
 * npm run test.e2e.seasonSchedule selects the schedule scenarios only.
 */
async function main(): Promise<void> {
  const artifacts = process.env.TS_REFINEMENTS_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_REFINEMENTS_ARTIFACTS')
  const web = join(artifacts, 'support/refinements-web')
  await mkdir(web, { recursive: true })
  await cp(resolve('dist'), web, { recursive: true })
  // Shift schedule dates by whole days while leaving server, browser, database,
  // session expiry and timeout clocks running normally.
  // These schedule checks use future game dates; this does not shift the
  // shared fixture's season frame or claim coverage of season-boundary rules.
  const dayMs = 24 * 60 * 60 * 1000
  const offset =
    Math.floor(Date.now() / dayMs) * dayMs - Date.parse('2026-10-06')
  const dateOf = (iso: string): Date => new Date(Date.parse(iso) + offset)
  const seed = await refinementsFixture(web, '127.0.0.1', dateOf)
  const { f } = seed
  await writeFile(
    join(artifacts, 'support/refinements-live-manifest.json'),
    JSON.stringify(
      {
        origin: f.h.origin,
        nativeOrigin: `http://127.0.0.1:${seed.nativePort}`,
        nativePort: seed.nativePort,
        season: f.seasonA,
        league: f.leagueA,
        teams: seed.teams,
        game: 'native-settings-game',
        managedGame: 'native-managed-game'
      },
      null,
      2
    )
  )
  const daemon = await maestro(
    process.env.MAESTRO_D ?? 'seasonGameRefinementsBrowser'
  )
  const sessions: BrowserSession[] = []
  const lines = join(artifacts, 'browser-scenarios.log')
  await writeFile(
    lines,
    '$ node -r sucrase/register src/app/seasonGameRefinements.e2e.ts\n'
  )
  const visit = async (b: BrowserSession, path: string): Promise<void> => {
    await b.m.openBrowser({ url: f.h.origin + path })
  }
  const login = async (b: BrowserSession, user: number): Promise<void> => {
    const email =
      user === 101
        ? 'alex@example.com'
        : user === 102
          ? 'casey@example.com'
          : `fixture${user}@example.com`
    await visit(b, '/sign-in')
    await fill(b.m, 'E-mail address', email)
    await tap(b.m, 'Send me a sign-in code')
    await show(b.m, '.*six-digit code is on its way.*')
    await fill(b.m, 'Sign-in code', f.h.mail.get(email)!)
    const verified = b.page.waitForResponse(response =>
      response.url().endsWith('/auth/email-code/verify')
    )
    await tap(b.m, 'Sign in')
    expect((await verified).status()).equals(200)
    await show(b.m, 'Search')
    const identity = await b.page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/me')
      return { status: response.status, id: (await response.json()).id }
    })
    expect(identity).deep.equals({ status: 200, id: userIdOfGumbo(user) })
  }
  const make = async (
    device: string,
    width = 1440,
    height = 1000,
    user?: number
  ): Promise<BrowserSession> => {
    const b = await browserSession(daemon, device, width, height, artifacts)
    sessions.push(b)
    if (user != null) await login(b, user)
    return b
  }
  const game = async (id: string): Promise<any> =>
    await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  /** Scrolls the schedule until every game its header counts is loaded. */
  const allGames = async (b: BrowserSession): Promise<void> => {
    await b.page.waitForFunction(
      () => {
        const counted = /(\d+) games?/.exec(document.body.innerText)
        const rows = document.querySelectorAll(
          '[data-scene-role="top"] [data-testid="schedule-display-row"]'
        )
        if (counted !== null && rows.length >= Number(counted[1])) return true
        // The list scrolls inside its own container; the last row's
        // reaching the end asks for the next page.
        if (rows.length > 0)
          rows[rows.length - 1].scrollIntoView({ block: 'end' })
        return false
      },
      { timeout: 30000, polling: 500 }
    )
  }
  const openSettings = async (b: BrowserSession, id: string): Promise<void> => {
    await visit(b, `/games/${id}/settings`)
    await contains(b.page, 'Swap home and away')
  }
  const choose = async (
    b: BrowserSession,
    old: string,
    name: string
  ): Promise<void> => {
    // The team's row, labelled with its side, opens the selector that slides up.
    const row = await diagnostic(b.page, () =>
      [...document.querySelectorAll('[data-scene-role="top"] [role="button"]')]
        .map(node => node.getAttribute('aria-label'))
        .filter(label => label !== null)
    )
    const label = row.find(text => text.startsWith(`${old}, `))
    if (label == null)
      throw new Error(`No row for ${old} among ${row.join(' | ')}`)
    await tap(b.m, label)
    await fill(b.m, 'Search all teams', name)
    await tap(b.m, `Choose ${name}`)
    await contains(b.page, name)
  }
  const pass = async (id: string, description: string): Promise<void> => {
    await log(artifacts, 'browser-scenarios.log', `${id} PASS: ${description}`)
  }
  const saveCoverage = async (): Promise<void> => {
    await recordBrowserCoverage(
      sessions.map(s => s.page),
      f.h.origin,
      process.env.TS_REFINEMENTS_BROWSER_COVERAGE ??
        resolve('coverage/refinements/browser.json'),
      web
    )
  }
  const openPublicProposal = async (
    visitor: BrowserSession,
    proposalId: string
  ): Promise<void> => {
    await visit(
      visitor,
      `/groups/season/${f.seasonA}?tab=schedule&when=upcoming`
    )
    await contains(visitor.page, 'Pending approval')
    const projection = await visitor.page.evaluate(async path => {
      const response = await fetch(path)
      return await response.json()
    }, `/api/v1/seasons/${f.seasonA}`)
    expect(
      projection.games.some(
        (row: { pendingRequestId?: string }) =>
          row.pendingRequestId === proposalId
      ),
      'UI login session authorizes the proposal'
    ).equals(true)
    // A full navigation first renders the anonymous projection; wait for the
    // UI login session to restore the authorized proposal action.
    await visitor.page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll(
            '[data-testid="schedule-display-row"][role="button"]'
          )
        ].some(row => {
          const label = row.getAttribute('aria-label')
          return (
            label != null &&
            label.includes('Demo Visitors @ Demo Eagles') &&
            label.includes('Pending approval')
          )
        }),
      { timeout: 15000 }
    )
    const label = await diagnostic(visitor.page, () =>
      [
        ...document.querySelectorAll(
          '[data-testid="schedule-display-row"][role="button"]'
        )
      ]
        .map(n => n.getAttribute('aria-label'))
        .find(
          name =>
            name != null &&
            name.includes('Demo Visitors @ Demo Eagles') &&
            name.includes('Pending approval')
        )
    )
    if (label == null) {
      await capture(visitor.m, artifacts, 'public-proposal-missing.png')
      throw new Error(
        'Authorized public proposal row missing: ' +
          (await diagnostic(visitor.page, () => document.body.innerText))
      )
    }
    await visitor.m.scrollUntilVisible({
      element: { text: label },
      centerElement: true,
      timeout: 15000
    })
    await capture(visitor.m, artifacts, 'public-season-authorized-proposal.png')
    await tap(visitor.m, label)
    await contains(visitor.page, 'Accept invitation')
    expect(new URL(visitor.page.url()).pathname).equals(
      `/notifications/${proposalId}`
    )
    await pass(
      'public-season-proposal-open',
      'Visiting team opens its authorized proposal from the shared public schedule row'
    )
  }
  try {
    const guest = await make('web-public-season-open', 1000, 900)
    const privateRequests: string[] = []
    const failedGameReads: string[] = []
    guest.page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (
        /\/api\/v1\/(videos\/[^/]+\/playback|games\/[^/]+\/(box-score|scheduling)|events\/[^/]+\/info|teams$|seasons\/[^/]+\/teams$)/.test(
          path
        )
      )
        privateRequests.push(path)
    })
    guest.page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (/\/api\/v1\/(games|videos)\//.test(path) && response.status() >= 400)
        failedGameReads.push(`${response.status()} ${path}`)
    })
    // Exercise the actual destination for each newly tappable public state.
    // Reuse one game, then restore it before the existing member scenarios.
    let restoreErrors: unknown[] = []
    try {
      for (const state of [
        'scheduled',
        'withdrawal',
        'replacement',
        'recorded'
      ] as const) {
        await f.h.db
          .updateTable('games')
          .set({
            status:
              state === 'recorded'
                ? 'final'
                : state === 'scheduled'
                  ? 'scheduled'
                  : 'cancelled',
            cancellation_reason:
              state === 'withdrawal' || state === 'replacement' ? state : null,
            withdrawn_by_team_id: state === 'withdrawal' ? f.teamA : null,
            withdrawn_at: state === 'withdrawal' ? new Date() : null
          })
          .where('id', '=', seed.gameId)
          .execute()
        if (state === 'recorded')
          await f.h.db
            .insertInto('videos')
            .values({
              id: 'public-schedule-recording',
              game_id: seed.gameId,
              title: 'Demo recording',
              kind: 'program',
              status: 'ready',
              storage: 'local',
              duration_sec: 30
            })
            .execute()
        await visit(guest, `/groups/season/${f.seasonA}?tab=schedule&when=all`)
        const selector = `[data-testid="public-game-${seed.gameId}"] [role="button"]`
        await guest.page.waitForSelector(selector)
        const label = await guest.page.$eval(selector, row =>
          row.getAttribute('aria-label')
        )
        if (label == null) throw new Error('Public schedule row has no label')
        await guest.m.scrollUntilVisible({
          element: { text: label },
          centerElement: true,
          timeout: 15000
        })
        const read = guest.page.waitForResponse(
          response =>
            new URL(response.url()).pathname === `/api/v1/games/${seed.gameId}`
        )
        await tap(guest.m, label)
        const response = await read
        expect(response.status()).equals(200)
        const detail = await response.json()
        expect(detail.nonMemberView).equals(true)
        await contains(guest.page, 'Demo Hawks')
        expect(new URL(guest.page.url()).pathname).equals(
          `/games/${seed.gameId}`
        )
        if (state !== 'recorded') {
          await contains(guest.page, 'Demo Field')
          await contains(guest.page, 'Sign in to view event information.')
        }
        if (state === 'withdrawal' || state === 'replacement')
          await contains(guest.page, 'Canceled')
        if (state === 'recorded') {
          expect(
            detail.videos.map((video: { id: string }) => video.id)
          ).includes('public-schedule-recording')
          expect(privateRequests).deep.equals([])
          expect(await guest.page.$('video')).equals(null)
          await tap(guest.m, 'Videos', 'tab')
          await guest.page.waitForSelector('[data-testid="gameVideoPreview"]')
          // A guest gets a real recording preview, never a playable media element.
          expect(await guest.page.$('video')).equals(null)
          expect(await guest.page.$('[data-testid="warningSheet"]')).equals(
            null
          )
          await capture(guest.m, artifacts, 'public-recorded-game-preview.png')
          await tap(guest.m, 'Play game video')
          await contains(guest.page, 'Log in / Sign up')
          expect(await guest.page.$('[data-testid="warningSheet"]')).not.equals(
            null
          )
          expect(await guest.page.$('video')).equals(null)
        }
        expect(privateRequests).deep.equals([])
        expect(failedGameReads).deep.equals([])
        await pass(
          `public-season-game-${state}`,
          'Guest opens the restricted game page without member-only reads or playback'
        )
      }
    } finally {
      const restored = await Promise.allSettled([
        f.h.db
          .deleteFrom('videos')
          .where('id', '=', 'public-schedule-recording')
          .execute(),
        f.h.db
          .updateTable('games')
          .set({
            status: 'scheduled',
            cancellation_reason: null,
            withdrawn_by_team_id: null,
            withdrawn_at: null
          })
          .where('id', '=', seed.gameId)
          .execute()
      ])
      restoreErrors = restored
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
    }
    // A scenario error propagates past this point unchanged; cleanup errors
    // are reported only when the scenario itself succeeded.
    if (restoreErrors.length > 0)
      throw new AggregateError(
        restoreErrors,
        'Could not restore schedule fixture'
      )
    const admin = await make('web-refinements', 1440, 1000, 101)
    await contains(admin.page, 'YOUR LEAGUES')
    const home = await diagnostic(admin.page, () => {
      const value = document.body.textContent
      return value === null ? '' : value
    })
    expect(home.indexOf('YOUR LEAGUES')).greaterThan(home.indexOf('SEASONS'))
    await absent(admin.page, 'Discover leagues, seasons and teams')
    const navOrder = await diagnostic(admin.page, () =>
      [...document.querySelectorAll('[aria-label]')]
        .map(n => n.getAttribute('aria-label'))
        .filter(
          n =>
            n !== null && ['Home', 'Videos', 'Schedule', 'Search'].includes(n)
        )
    )
    expect(navOrder).deep.equals(['Home', 'Videos', 'Schedule', 'Search'])
    await capture(admin.m, artifacts, 'home-after.png')
    await admin.m.scrollUntilVisible({
      element: { text: 'YOUR LEAGUES' },
      centerElement: true,
      timeout: 15000
    })
    await capture(admin.m, artifacts, 'home-leagues-after.png')
    await tap(admin.m, 'Search', 'tab')
    // Signed in, Search is for following; a team opens followed or not.
    await contains(admin.page, 'A team opens on its own page, followed or not')
    await visit(admin, `/groups/league/${f.leagueA}`)
    await contains(admin.page, 'Demo League A')
    await capture(admin.m, artifacts, 'league-after.png')
    await tap(admin.m, 'League settings')
    await contains(admin.page, 'Save name')
    const mobile = await make('web-refinements-mobile', 390, 844, 101)
    await contains(mobile.page, 'YOUR TEAMS')
    await capture(mobile.m, artifacts, 'mobile-nav-after.png')
    await tap(mobile.m, 'Search', 'tab')
    await contains(mobile.page, 'Discover')
    await pass(
      'B1',
      'league section last, Search after Schedule at desktop/mobile, discovery and hero settings gear work'
    )

    await visit(admin, '/')
    const seasonLabel = await diagnostic(admin.page, () =>
      [...document.querySelectorAll('[role="button"]')]
        .map(n => n.getAttribute('aria-label'))
        .find(label => label != null && label.startsWith('Demo Regular,'))
    )
    if (seasonLabel == null) throw new Error('Home season action missing')
    await tap(admin.m, seasonLabel)
    await contains(admin.page, 'Include Exhibitions')
    const seasonPath = `/groups/season/${f.seasonA}`
    await visit(admin, seasonPath)
    await contains(admin.page, 'Demo Foxes')
    await capture(admin.m, artifacts, 'season-after.png')
    for (const name of ['Standings', 'Schedule', 'Stats', 'Videos', 'Teams'])
      expect(
        await diagnostic(admin.page, () =>
          [...document.querySelectorAll('[role="tab"]')].map(n => n.textContent)
        )
      ).includes(name)
    await visit(admin, `/seasons/${f.seasonA}?tab=invalid`)
    await contains(admin.page, 'Include Exhibitions')
    expect(new URL(admin.page.url()).searchParams.get('tab')).equals(
      'standings'
    )
    await tap(admin.m, 'Schedule', 'tab')
    await tap(admin.m, 'Upcoming', 'tab')
    await contains(admin.page, 'Pending approval')
    await capture(admin.m, artifacts, 'pending-after.png')
    const pendingLabel = await diagnostic(admin.page, () =>
      [...document.querySelectorAll('[role="button"]')]
        .map(n => n.getAttribute('aria-label'))
        .find(
          label =>
            label != null &&
            label.includes('Demo Visitors') &&
            label.includes('Pending approval')
        )
    )
    if (pendingLabel == null) throw new Error('Season pending action missing')
    await admin.m.scrollUntilVisible({
      element: { text: pendingLabel },
      centerElement: true,
      timeout: 15000
    })
    await tap(admin.m, pendingLabel)
    await contains(admin.page, 'Withdraw invitation')
    expect(new URL(admin.page.url()).pathname).equals(
      `/notifications/${seed.pendingId}`
    )
    await visit(admin, '/schedule?when=upcoming')
    await contains(admin.page, 'Pending approval')
    await capture(admin.m, artifacts, 'pending-global-after.png')
    await visit(admin, `/teams/${f.teamA}?tab=schedule`)
    await contains(admin.page, 'Pending approval')
    await capture(admin.m, artifacts, 'pending-team-after.png')
    await pass(
      'B2 pending navigation regression',
      'season pending row opens its request, and global/team schedules show Pending approval'
    )
    await visit(admin, `/seasons/${f.seasonA}?tab=schedule&when=upcoming`)
    await contains(admin.page, 'Pending approval')
    await tap(admin.m, 'All', 'tab')
    await contains(admin.page, '0–7')
    await admin.m.command('blockNetwork', {
      patterns: [`*/api/v1/seasons/${f.seasonA}/stats*`]
    })
    await tap(admin.m, 'Stats', 'tab')
    await contains(admin.page, 'Retry stats')
    await admin.m.command('clearNetworkMocks')
    await tap(admin.m, 'Retry stats')
    await contains(admin.page, 'Demo C')
    await capture(admin.m, artifacts, 'season-stats-after.png')
    await tap(admin.m, 'Videos', 'tab')
    await contains(admin.page, 'No recorded games here yet.')
    await capture(admin.m, artifacts, 'season-videos-after.png')
    await admin.m.command('blockNetwork', {
      patterns: [
        `*/api/v1/events?season=${encodeURIComponent(f.seasonA)}*`,
        `*/api/v1/seasons/${f.seasonA}/standings*`
      ]
    })
    await visit(admin, `/seasons/${f.seasonA}?tab=standings`)
    await contains(admin.page, 'Retry season')
    await contains(admin.page, 'Retry standings')
    await admin.m.command('clearNetworkMocks')
    await tap(admin.m, 'Retry season')
    // Retrying the season removes its error panel and moves the standings
    // retry control. Wait for that reflow before locating the second button.
    await admin.page.waitForFunction(() => {
      const body = document.body.textContent
      return body !== null && !body.includes('Retry season')
    })
    await admin.m.waitForAnimationToEnd()
    await tap(admin.m, 'Retry standings')
    await contains(admin.page, '.500')
    await absent(admin.page, 'Retry season')
    await absent(admin.page, 'Retry standings')
    const publicView = await make('web-refinements-public')
    const publicRequests: string[] = []
    publicView.page.on('request', r => {
      publicRequests.push(r.url())
    })
    await visit(publicView, seasonPath)
    await contains(publicView.page, 'Demo Regular')
    await absent(publicView.page, 'BATTING')
    expect(
      publicRequests.some(url => url.includes(`/seasons/${f.seasonA}/stats`))
    ).equals(false)
    await pass(
      'B2',
      'five season tabs, route correction/date filters, real network-interruption retries preserving selection, populated Stats, empty Videos and public stats boundary verified'
    )

    await visit(admin, seasonPath)
    await contains(admin.page, 'Demo Foxes')
    await contains(admin.page, '.500')
    const inSeason = await (
      await f.h.request(
        'GET',
        `/seasons/${f.seasonA}/standings?includeExhibitions=false`,
        undefined,
        101
      )
    ).json()
    expect(inSeason.find((r: any) => r.teamId === f.teamA)).deep.includes({
      w: 1,
      l: 1,
      t: 1,
      winningPct: 0.5,
      gamesBehind: 1,
      runsFor: 10,
      runsAgainst: 12,
      runDifferential: -2,
      streak: 'L1'
    })
    await tap(admin.m, 'Include Exhibitions', 'tab')
    await contains(admin.page, '.625')
    await capture(admin.m, artifacts, 'standings-after.png')
    const overall = await (
      await f.h.request(
        'GET',
        `/seasons/${f.seasonA}/standings?includeExhibitions=true`,
        undefined,
        101
      )
    ).json()
    expect(overall.find((r: any) => r.teamId === f.teamA)).deep.includes({
      w: 2,
      l: 1,
      t: 1,
      winningPct: 0.625,
      gamesBehind: 0.5,
      runsFor: 17,
      runsAgainst: 12,
      runDifferential: 5,
      streak: 'W1'
    })
    expect(overall.find((r: any) => r.teamId === seed.teams.Foxes)).includes({
      teamKind: 'external',
      played: 1
    })
    await pass(
      'B3',
      'known tie-half-win records, runs/GB/streak/home-away and overall exhibition inclusion match rendered standings; placeholder legitimately ranks'
    )

    await tap(admin.m, 'Teams', 'tab')
    await contains(
      admin.page,
      "These teams are in the season but don't have scheduled games."
    )
    await capture(admin.m, artifacts, 'teams-after.png')
    const teamPage = await diagnostic(admin.page, () => document.body.innerText)
    expect(teamPage.indexOf('EXHIBITION TEAMS')).greaterThan(
      teamPage.indexOf('Demo Hawks')
    )
    expect(teamPage.indexOf('UNSCHEDULED')).greaterThan(
      teamPage.indexOf('Demo Visitors')
    )
    expect(teamPage.match(/Demo Hawks/g)).length(1)
    await admin.m.scrollUntilVisible({
      element: { text: 'These teams are in the season.*' },
      centerElement: true,
      timeout: 15000
    })
    await capture(admin.m, artifacts, 'teams-sections-after.png')
    const sticky = await diagnostic(admin.page, () => {
      const node = document.querySelector(
        '[data-testid="sticky-season-sections"]'
      )
      const r = node == null ? null : node.getBoundingClientRect()
      return r == null
        ? null
        : { top: r.top, bottom: r.bottom, height: innerHeight }
    })
    expect(sticky?.top).at.least(0)
    expect(sticky?.bottom).lessThan((sticky?.height ?? 0) / 2)
    // The season's people, on its People tab now the Manage page is gone.
    await visit(admin, `/seasons/${f.seasonA}?tab=people`)
    // The league's administrator, inherited and pilled, and the child only
    // as a player of the season's Demo Comets: an administrator may read
    // both names in full.
    await contains(admin.page, 'ADMINS')
    await contains(admin.page, 'Demo League Admin\nLeague admin')
    await contains(admin.page, 'PLAYERS')
    await contains(admin.page, 'Demo Child Player\nDemo Comets')
    await capture(admin.m, artifacts, 'people-after.png')
    await pass(
      'B4',
      'mixed teams appear once upper, exhibition-only and unscheduled are disjoint, placeholder badge and parent-only people verified; sticky tabs remain visible after scroll'
    )

    // The schedule regression pass does not exercise unrelated game-edit forms.
    if (process.env.TS_REFINEMENTS_SCHEDULE_ONLY === '1') {
      const proposal = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonA },
          game: {
            homeTeamId: f.teamB,
            awayTeamId: f.standaloneTeam,
            seasonId: f.seasonA,
            startAt: dateOf('2026-10-29T19:00:00Z').toISOString(),
            venue: 'Demo Host-only Field',
            status: 'scheduled'
          },
          idempotencyKey: 'public-schedule-proposal'
        },
        101
      )
      expect(proposal.status).equals(201)
      const proposalId = (await proposal.json()).id
      expect(
        (
          await f.h.request(
            'POST',
            `/game-requests/${proposalId}/accept`,
            {},
            102
          )
        ).status
      ).equals(200)
      const visitor = await make('web-public-season-proposal', 1000, 900, 103)
      await openPublicProposal(visitor, proposalId)
      await saveCoverage()
      await writeFile(
        join(artifacts, 'support/refinements-finished-manifest.json'),
        JSON.stringify(
          { scope: 'schedule-only', game: seed.gameId, season: f.seasonA },
          null,
          2
        )
      )
      await pass(
        'schedule-only',
        'Selected public schedule and B1–B4 scenarios complete; game-edit and native scenarios excluded'
      )
      return
    }

    await visit(admin, `/games/${seed.gameId}`)
    // The gear has no visible text; its accessible name is the label.
    await show(admin.m, 'Event settings')
    await tap(admin.m, 'Event settings')
    await contains(admin.page, 'Game Settings')
    await capture(admin.m, artifacts, 'game-settings-after.png')
    const before = await game(seed.gameId)
    await tap(admin.m, 'Swap home and away')
    await chooseDate(
      admin.m,
      'Date',
      dateOf('2026-10-24').toISOString().slice(0, 10)
    )
    await chooseTime(admin.m, 'Start time', '16:45')
    await chooseTimezone(admin.m, 'America/Los_Angeles')
    await fill(admin.m, 'Venue name (optional)', 'Preview only field')
    await tap(admin.m, 'Cancel')
    expect(await game(seed.gameId)).deep.equals(before)
    await openSettings(admin, seed.managedGameId)
    const count = (await f.h.db.selectFrom('teams').select('id').execute())
      .length
    await tap(admin.m, 'Demo Comets, Away')
    await contains(admin.page, 'Demo Unscheduled')
    await tap(
      admin.m,
      'Create Placeholder Team, A team that is not on TeamStation yet'
    )
    await fill(admin.m, 'Team name', 'Demo Preview Opponent')
    await tap(admin.m, 'Continue')
    await tap(admin.m, 'Skip')
    await admin.m.waitForAnimationToEnd()
    await tap(admin.m, 'Skip')
    await contains(admin.page, 'Demo Preview Opponent')
    await tap(admin.m, 'Cancel')
    expect(
      (await f.h.db.selectFrom('teams').select('id').execute()).length
    ).equals(count)
    await pass(
      'B5',
      'separate Settings preview/swap/venue and staged-placeholder Cancel leave stored matchup and team count unchanged'
    )

    const opponent = await make('web-refinements-opponent', 1440, 1000, 102)
    const visitors = await make('web-refinements-visitors', 1440, 1000, 103)
    await openSettings(admin, seed.managedGameId)
    await choose(admin, 'Demo Comets', 'Demo Visitors')
    await contains(
      admin.page,
      'An administrator, coach or assistant of Demo Visitors must approve changes.'
    )
    await tap(admin.m, 'Save')
    await contains(admin.page, 'Game proposal sent')
    const retained = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('game_id', '=', seed.managedGameId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow()
    expect((await game(seed.managedGameId)).away_team_id).equals(
      seed.teams.Comets
    )
    await visit(admin, seasonPath + '?tab=schedule&when=upcoming')
    await contains(admin.page, 'Pending approval')
    await visit(visitors, `/notifications/${retained.id}`)
    await contains(visitors.page, 'Demo Visitors')
    await tap(visitors.m, 'Accept invitation')
    await contains(visitors.page, 'Accepted')
    expect((await game(seed.managedGameId)).away_team_id).equals(
      f.standaloneTeam
    )
    // The Eagles' own admin proposes: the season's admin, who also runs the
    // Hawks, consents for both sides of a season game and saves at once.
    const finalId = 'baseline-hawks-eagles'
    await openSettings(opponent, finalId)
    await fill(opponent.m, 'Venue name (optional)', 'Demo Proposed Final Field')
    await tap(opponent.m, 'Save')
    await contains(opponent.page, 'Game proposal sent')
    const finalProposal = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('game_id', '=', finalId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow()
    await visit(admin, `/seasons/${f.seasonA}?tab=schedule&when=all`)
    await contains(admin.page, 'Pending approval')
    await allGames(admin)
    await absent(admin.page, '2–5')
    await visit(admin, `/notifications/${finalProposal.id}`)
    await tap(admin.m, 'Decline invitation')
    await contains(admin.page, 'Declined')
    await visit(admin, `/seasons/${f.seasonA}?tab=schedule&when=all`)
    await allGames(admin)
    await contains(admin.page, '2–5')
    await openSettings(opponent, finalId)
    await fill(opponent.m, 'Venue name (optional)', 'Demo Expiring Final Field')
    await tap(opponent.m, 'Save')
    await contains(opponent.page, 'Game proposal sent')
    const expiring = await f.h.db
      .selectFrom('group_requests')
      .select('id')
      .where('game_id', '=', finalId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow()
    await f.h.db
      .updateTable('group_requests')
      .set({
        sent_at: dateOf('2026-09-01T19:00:00Z'),
        expires_at: dateOf('2026-09-08T19:00:00Z')
      })
      .where('id', '=', expiring.id)
      .execute()
    await visit(admin, `/seasons/${f.seasonA}?tab=schedule&when=all`)
    await allGames(admin)
    await contains(admin.page, '2–5')
    expect((await game(finalId)).venue).equals('Demo Field')
    await pass(
      'B6',
      'managed originals retain ID and approved matchup pending replacement; inbox acceptance updates same ID; Pending approval overrides final score, decline and expiry restore score presentation without changing approved fields'
    )

    await openSettings(admin, seed.gameId)
    await choose(admin, 'Demo Eagles', 'Demo Visitors')
    await tap(admin.m, 'Save')
    await contains(admin.page, 'Game proposal sent')
    const replacement = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('kind', '=', 'game')
      .where('status', '=', 'pending')
      .execute()
    const request = replacement.find(
      r => (r.terms as any).replacesGameId === seed.gameId
    )!
    expect(await game(seed.gameId)).includes({
      status: 'cancelled',
      cancellation_reason: 'replacement'
    })
    await visit(admin, seasonPath + '?tab=schedule&when=upcoming')
    await contains(admin.page, 'Pending approval')
    await contains(admin.page, 'Canceled')
    await capture(admin.m, artifacts, 'replacement-history.png')
    await visit(opponent, '/notifications?history=1')
    await tap(opponent.m, 'History')
    await contains(opponent.page, 'Game canceled after an opponent change')
    await visit(visitors, `/notifications/${request.id}`)
    await tap(visitors.m, 'Accept invitation')
    await contains(visitors.page, 'Accepted')
    const accepted = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', request.id)
      .executeTakeFirstOrThrow()
    expect(accepted.game_id).equals((request.terms as any).proposedGameId)
    expect(accepted.game_id).not.equals(seed.gameId)
    expect((await game(seed.gameId)).status).equals('cancelled')
    const decliningId = 'browser-declined-original'
    await f.h.db
      .insertInto('games')
      .values({
        id: decliningId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: dateOf('2026-10-21T18:00:00Z'),
        venue: 'Demo Decline Field',
        status: 'scheduled'
      })
      .execute()
    await openSettings(admin, decliningId)
    await choose(admin, 'Demo Eagles', 'Demo Visitors')
    await tap(admin.m, 'Save')
    await contains(admin.page, 'Game proposal sent')
    const declines = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('kind', '=', 'game')
      .where('status', '=', 'pending')
      .execute()
    const declinedRequest = declines.find(
      r => (r.terms as any).replacesGameId === decliningId
    )!
    const key = await f.h.db
      .selectFrom('creation_idempotency')
      .select('key')
      .where(sql<string>`response->>'id'`, '=', declinedRequest.id)
      .executeTakeFirstOrThrow()
    const old = await game(decliningId)
    const replayPayload = {
      sender: {
        kind: declinedRequest.sender_scope_type,
        id: declinedRequest.sender_scope_id
      },
      game: (declinedRequest.terms as any).game,
      gameId: decliningId,
      expected: gameVersion({ ...materialGame(old), status: 'scheduled' }),
      initiatingTeamId: declinedRequest.initiating_team_id,
      idempotencyKey: key.key
    }
    const replay = await f.h.request(
      'POST',
      '/game-requests',
      replayPayload,
      101
    )
    expect(replay.status).equals(201)
    expect((await replay.json()).id).equals(declinedRequest.id)
    await visit(visitors, `/notifications/${declinedRequest.id}`)
    await tap(visitors.m, 'Decline invitation')
    await contains(visitors.page, 'Declined')
    const proposalCount = (
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length
    const closedReplay = await f.h.request(
      'POST',
      '/game-requests',
      replayPayload,
      101
    )
    expect(closedReplay.status).equals(201)
    expect(await closedReplay.json()).includes({
      id: declinedRequest.id,
      status: 'declined'
    })
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(proposalCount)
    await pass(
      'B7 closed replay diagnostic',
      'real idempotent API retry after UI decline returns the same request with current Declined status and creates no second proposal'
    )
    expect((await game(decliningId)).status).equals('cancelled')
    expect(
      await f.h.db
        .selectFrom('games')
        .select('id')
        .where('id', '=', (declinedRequest.terms as any).proposedGameId)
        .execute()
    ).length(0)
    await pass(
      'B7',
      'unmanaged removed opponent retains canceled history before approval; cancellation inbox, distinct acceptance, retry identity and declined replacement preserving cancellation verified'
    )

    const saveId = 'browser-immediate-game'
    await f.h.db
      .insertInto('games')
      .values({
        id: saveId,
        home_team_id: f.teamA,
        away_team_id: seed.teams.Comets,
        season_id: f.seasonA,
        start_at: dateOf('2026-10-22T18:00:00Z'),
        venue: 'Demo Original',
        status: 'scheduled'
      })
      .execute()
    await openSettings(admin, saveId)
    await tap(admin.m, 'Demo Comets, Away')
    await contains(admin.page, 'Demo Unscheduled')
    await tap(
      admin.m,
      'Create Placeholder Team, A team that is not on TeamStation yet'
    )
    await fill(admin.m, 'Team name', 'Demo Saved Opponent')
    await tap(admin.m, 'Continue')
    await tap(admin.m, 'Skip')
    await admin.m.waitForAnimationToEnd()
    await tap(admin.m, 'Skip')
    await chooseDate(
      admin.m,
      'Date',
      dateOf('2026-10-22').toISOString().slice(0, 10)
    )
    await chooseTime(admin.m, 'Start time', '20:15')
    await chooseTimezone(admin.m, 'America/Los_Angeles')
    await tap(admin.m, 'Exhibition', 'switch')
    await tap(admin.m, 'Save')
    await contains(admin.page, 'Game changes saved')
    await capture(admin.m, artifacts, 'success-toast.png')
    const toast = await diagnostic(admin.page, () => {
      const node = [...document.querySelectorAll('[role="alert"]')].find(
        // "Game changes saved: <home> vs <away> in <season>"
        n =>
          n.textContent !== null &&
          n.textContent.startsWith('Game changes saved')
      )
      if (node == null) return null
      const r = node.getBoundingClientRect()
      return {
        color: getComputedStyle(node).color,
        background:
          node.parentElement == null
            ? ''
            : getComputedStyle(node.parentElement).backgroundColor,
        bottom: r.bottom,
        height: innerHeight
      }
    })
    expect(toast?.color).equals('rgb(255, 255, 255)')
    expect(toast?.background).equals('rgba(23, 105, 210, 0.82)')
    expect(toast?.bottom).lessThan(toast?.height ?? 0)
    const created = await f.h.db
      .selectFrom('teams')
      .selectAll()
      .where('name', '=', 'Demo Saved Opponent')
      .execute()
    expect(created).length(1)
    expect(created[0]).includes({
      kind: 'external',
      custodian_type: 'team',
      custodian_id: seed.teams.Comets
    })
    expect((await game(saveId)).away_team_id).equals(created[0].id)
    expect(await game(saveId)).includes({
      timezone: 'America/Los_Angeles',
      exhibition: true
    })
    expect(
      (await game(saveId)).start_at.toLocaleString('sv-SE', {
        timeZone: 'America/Los_Angeles'
      })
    ).equals(dateOf('2026-10-22').toISOString().slice(0, 10) + ' 20:15:00')
    await admin.page.waitForFunction(
      () =>
        document.body.textContent == null ||
        !document.body.textContent.includes('Game changes saved'),
      { timeout: 8000 }
    )
    await openSettings(admin, saveId)
    await fill(admin.m, 'Venue name (optional)', 'Recoverable draft')
    await f.h.db
      .updateTable('games')
      .set({ venue: 'Another committed field' })
      .where('id', '=', saveId)
      .execute()
    await tap(admin.m, 'Save')
    await contains(admin.page, 'Review the current game')
    await absent(admin.page, 'Game changes saved')
    expect(
      await diagnostic(admin.page, () => {
        const node = document.querySelector<HTMLInputElement>(
          'input[aria-label="Venue name (optional)"]'
        )
        return node == null ? undefined : node.value
      })
    ).equals('Recoverable draft')
    await capture(admin.m, artifacts, 'game-settings-error-after.png')
    await tap(admin.m, 'Cancel')
    await openSettings(admin, saveId)
    await tap(admin.m, 'Withdraw Demo Hawks')
    await tap(admin.m, 'Confirm withdrawal')
    await contains(admin.page, 'Game changes saved')
    expect(await game(saveId)).includes({
      status: 'cancelled',
      cancellation_reason: 'withdrawal',
      withdrawn_by_team_id: f.teamA
    })
    await pass(
      'B8',
      'inherited/custodian authority saves one placeholder immediately; toast appears and clears after five seconds; stale error preserves draft without toast; withdrawal keeps attributed canceled event'
    )
    // A manager adds a game from the team's Schedule tab.
    await visit(admin, `/teams/${f.teamA}?tab=schedule`)
    await tap(admin.m, 'Add Game')
    // A team page's game is a scrimmage or exhibition: there is no season
    // to choose, and none is sent.
    await contains(admin.page, 'always creates a scrimmage/exhibition game')
    await absent(admin.page, 'Find a season you manage')
    await tap(admin.m, 'Choose Away Team, Away')
    await fill(admin.m, 'Search all teams', 'Demo Eagles')
    await admin.page.waitForFunction(() =>
      [...document.querySelectorAll('[role="button"]')].some(n => {
        const label = n.getAttribute('aria-label')
        return label !== null && label.startsWith('Choose Demo Eagles')
      })
    )
    const opponentLabel = await diagnostic(admin.page, () =>
      [...document.querySelectorAll('[role="button"]')]
        .map(n => n.getAttribute('aria-label'))
        .find(label => label != null && label.startsWith('Choose Demo Eagles'))
    )
    if (opponentLabel == null)
      throw new Error('Administered-season opponent action missing')
    await tap(admin.m, opponentLabel)
    await chooseDate(
      admin.m,
      'Date',
      dateOf('2026-10-28').toISOString().slice(0, 10)
    )
    await chooseTime(admin.m, 'Start time', '19:00')
    await fill(admin.m, 'Venue name (optional)', 'Demo Administered Host Field')
    await tap(admin.m, 'Save')
    await contains(admin.page, 'Pending')
    const foreignId = new URL(admin.page.url()).pathname.split('/').at(-1)!
    const foreign = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', foreignId)
      .executeTakeFirstOrThrow()
    expect(foreign).includes({
      sender_scope_type: 'team',
      sender_scope_id: f.teamA,
      initiating_team_id: f.teamA,
      status: 'pending'
    })
    expect((foreign.terms as any).game).includes({
      seasonId: null,
      exhibition: true
    })
    await visit(opponent, `/notifications/${foreignId}`)
    await tap(opponent.m, 'Accept invitation')
    await contains(opponent.page, 'Accepted')
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .select('team_id')
        .where('team_id', '=', f.teamA)
        .where('season_id', '=', f.seasonB)
        .execute()
    ).length(0)
    await pass(
      'B8 regression',
      'a team-origin game is an exhibition in no season, keeps the team sender and two-team consent, and creates no season membership'
    )
    await visit(admin, `/groups/season/${f.seasonA}?tab=schedule&when=upcoming`)
    await tap(admin.m, 'Create Game')
    await tap(admin.m, 'Choose Home Team, Home')
    await fill(admin.m, 'Search all teams', 'Demo Eagles')
    await admin.page.waitForFunction(() =>
      [...document.querySelectorAll('[role="button"]')].some(n => {
        const label = n.getAttribute('aria-label')
        return label !== null && label.startsWith('Choose Demo Eagles')
      })
    )
    const homeGuest = await diagnostic(admin.page, () =>
      [...document.querySelectorAll('[role="button"]')]
        .map(n => n.getAttribute('aria-label'))
        .find(label => label != null && label.startsWith('Choose Demo Eagles'))
    )
    if (homeGuest == null) throw new Error('Host-only home opponent missing')
    await tap(admin.m, homeGuest)
    await tap(admin.m, 'Choose Away Team, Away')
    await fill(admin.m, 'Search all teams', 'Demo Visitors')
    await admin.page.waitForFunction(() =>
      [...document.querySelectorAll('[role="button"]')].some(n => {
        const label = n.getAttribute('aria-label')
        return label !== null && label.startsWith('Choose Demo Visitors')
      })
    )
    const awayGuest = await diagnostic(admin.page, () =>
      [...document.querySelectorAll('[role="button"]')]
        .map(n => n.getAttribute('aria-label'))
        .find(
          label => label != null && label.startsWith('Choose Demo Visitors')
        )
    )
    if (awayGuest == null) throw new Error('Host-only away opponent missing')
    await tap(admin.m, awayGuest)
    await chooseDate(
      admin.m,
      'Date',
      dateOf('2026-10-29').toISOString().slice(0, 10)
    )
    await chooseTime(admin.m, 'Start time', '19:00')
    await fill(admin.m, 'Venue name (optional)', 'Demo Host-only Field')
    await tap(admin.m, 'Save')
    await contains(admin.page, 'Pending')
    const hostOnlyId = new URL(admin.page.url()).pathname.split('/').at(-1)!
    const sides = await f.h.db
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', '=', hostOnlyId)
      .execute()
    expect(sides).length(2)
    expect(
      sides.every(
        side => side.scope_type === 'team' && side.approved_by === null
      )
    ).equals(true)
    await absent(admin.page, 'Accept invitation')
    expect(
      (
        await f.h.request(
          'POST',
          `/game-requests/${hostOnlyId}/accept`,
          {},
          101
        )
      ).status
    ).equals(403)
    await visit(opponent, `/notifications/${hostOnlyId}`)
    await tap(opponent.m, 'Accept invitation')
    await contains(opponent.page, 'Pending')
    const publicSeason = await f.h.request(
      'GET',
      `/seasons/${f.seasonA}`,
      undefined,
      103
    )
    expect(publicSeason.status).equals(200)
    const publicDetails = await publicSeason.json()
    expect(publicDetails.canViewPrivate).equals(false)
    expect(
      publicDetails.games.find(
        (row: any) => row.pendingRequestId === hostOnlyId
      )
    ).not.equals(undefined)
    await openPublicProposal(visitors, hostOnlyId)
    await tap(visitors.m, 'Accept invitation')
    await contains(visitors.page, 'Accepted')
    const hostPublished = await f.h.db
      .selectFrom('group_requests')
      .select('game_id')
      .where('id', '=', hostOnlyId)
      .executeTakeFirstOrThrow()
    if (hostPublished.game_id == null)
      throw new Error('Accepted host-only proposal has no published game')
    await visit(admin, `/games/${hostPublished.game_id}?tab=watch`)
    await contains(admin.page, 'No videos')
    await absent(admin.page, 'Event settings')
    const requestCount = (
      await f.h.db.selectFrom('group_requests').select('id').execute()
    ).length
    const gameCount = (await f.h.db.selectFrom('games').select('id').execute())
      .length
    const unauthorizedPlacement = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: seed.teams.Comets,
          seasonId: f.seasonB,
          startAt: dateOf('2026-10-30T19:00:00Z').toISOString(),
          venue: 'Demo Unauthorized Host',
          status: 'scheduled'
        },
        idempotencyKey: 'browser-host-placement-denied'
      },
      101
    )
    expect(unauthorizedPlacement.status).equals(403)
    const currentGuestGame = await game(hostPublished.game_id)
    const unauthorizedEdit = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        gameId: hostPublished.game_id,
        expected: gameVersion(materialGame(currentGuestGame)),
        game: {
          ...materialGame(currentGuestGame),
          homeTeamId: f.teamA,
          awayTeamId: seed.teams.Comets
        },
        idempotencyKey: 'browser-proposed-owner-edit-denied'
      },
      101
    )
    expect(unauthorizedEdit.status).equals(403)
    expect((await game(hostPublished.game_id)).status).equals('scheduled')
    expect(
      await f.h.db.selectFrom('group_requests').select('id').execute()
    ).length(requestCount)
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(
      gameCount
    )
    await pass(
      'B8 authority regression',
      'host placement and original-team edit authorization enforced without a third consent side or unauthorized cancellation'
    )
    await pass(
      'B8 host-only regression',
      'Season administrator sends two unmanaged teams with zero team consent; both team administrators approve, host approval/edit controls remain unavailable'
    )

    await saveCoverage()
    await writeFile(
      join(artifacts, 'support/refinements-finished-manifest.json'),
      JSON.stringify(
        {
          origin: f.h.origin,
          nativePort: seed.nativePort,
          season: f.seasonA,
          league: f.leagueA,
          teams: seed.teams,
          game: seed.gameId,
          managedGame: seed.managedGameId
        },
        null,
        2
      )
    )
    if (process.env.TS_REFINEMENTS_KEEP_FIXTURE === '1') {
      await f.h.db
        .insertInto('games')
        .values([
          {
            id: 'native-settings-game',
            home_team_id: f.teamA,
            away_team_id: f.teamB,
            season_id: f.seasonA,
            start_at: dateOf('2026-10-15T18:30:00Z'),
            venue: 'Demo Field',
            status: 'scheduled'
          },
          {
            id: 'native-managed-game',
            home_team_id: f.teamA,
            away_team_id: seed.teams.Comets,
            season_id: f.seasonA,
            start_at: dateOf('2026-10-16T18:30:00Z'),
            venue: 'Demo Managed Field',
            status: 'scheduled'
          }
        ])
        .execute()
      console.log(
        'Browser suite passed; isolated native fixture remains ready until quit.'
      )
      for await (const line of createInterface({
        input: process.stdin,
        terminal: false
      }))
        if (line === 'quit') break
    }
  } finally {
    for (const s of sessions) {
      await s.browser.disconnect()
      await s.m.detach()
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
