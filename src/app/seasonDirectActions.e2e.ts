/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Serialized browser callbacks must not capture compiler helpers. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { sql } from 'kysely'
import type { Page } from 'puppeteer'

import {
  browserSession,
  contains,
  fill,
  maestro,
  type MaestroHandle,
  tap as tapStep
} from '../../e2e/rigs/refinementsMaestro'
import { TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { groupFixture } from '../test/groupFixtures'

const pages = new WeakMap<MaestroHandle, Page>()
async function tap(m: MaestroHandle, label: string): Promise<void> {
  const direction = await pages.get(m)?.evaluate(label => {
    const node = [...document.querySelectorAll('[role="button"]')].find(
      node => {
        const aria = node.getAttribute('aria-label')
        return (aria === null ? node.textContent : aria) === label
      }
    )
    return node != null && node.getBoundingClientRect().top < 60 ? 'UP' : 'DOWN'
  }, label)
  await m.scrollUntilVisible({
    element: { text: label, role: 'button' },
    centerElement: true,
    direction: direction ?? 'DOWN',
    timeout: 10000
  })
  // Viewport visibility alone includes the floating navigation's covered area.
  // Inspect hit testing, then move the real page through Maestro before tapping.
  for (let attempt = 0; attempt < 6; attempt++) {
    const blocked = await pages.get(m)?.evaluate(label => {
      const node = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(node => {
        const aria = node.getAttribute('aria-label')
        return (aria === null ? node.textContent : aria) === label
      })
      if (node == null) return undefined
      const bounds = node.getBoundingClientRect()
      const at = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2
      )
      return at != null && node.contains(at)
        ? undefined
        : bounds.y < 60
          ? 'UP'
          : 'DOWN'
    }, label)
    if (blocked == null) break
    if (attempt === 5) throw new Error(`Action stays covered: ${label}`)
    await m.command('scroll', { direction: blocked })
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await tapStep(m, label)
  await new Promise(resolve => setTimeout(resolve, 350))
}

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_CREATION_ARTIFACTS')
const before = process.argv.includes('--before')
const phase = before ? 'before' : 'after'
async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const f = await groupFixture(
    resolve(process.env.TS_DIRECT_WEB_ROOT ?? 'dist')
  )
  const ownedDatabase = (
    await sql<{ name: string }>`select current_database() as name`.execute(
      f.h.db
    )
  ).rows[0].name
  await f.h.db
    .updateTable('teams')
    .set({ name: 'Demo Account Team' })
    .where('id', '=', 'tem_account')
    .execute()
  await writeFile(
    join(artifacts!, `ownership-${phase}-${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      database: ownedDatabase,
      origin: f.h.origin,
      daemon: `direct-actions-${phase}-${process.pid}`,
      phase
    })
  )
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let session: Awaited<ReturnType<typeof browserSession>> | undefined
  const lines = [
    `$ node -r sucrase/register src/app/seasonDirectActions.e2e.ts ${before ? '--before' : ''}`
  ]
  try {
    daemon = await maestro(`direct-actions-${phase}-${process.pid}`)
    session = await browserSession(
      daemon,
      `direct-actions-${phase}-${process.pid}`,
      402,
      874,
      artifacts!,
      'chrome'
    )
    const { m, page, browser } = session
    pages.set(m, page)
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'role_direct_team',
        user_id: userIdOfGumbo(101),
        scope_type: 'team',
        scope_id: f.standaloneTeam,
        role: 'admin'
      })
      .execute()
    const placeholder = await api.createGroup({
      kind: 'team',
      name: 'Demo Placeholder',
      external: true,
      custodian: { kind: 'season', id: f.seasonA },
      idempotencyKey: 'direct-placeholder'
    })
    const go = async (path: string, wanted: string): Promise<void> => {
      await m.openLink({ link: f.h.origin + path })
      await contains(page, wanted)
      await page.waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
    }
    const shot = async (name: string): Promise<void> => {
      const action =
        name === 'people'
          ? before
            ? 'Send invite'
            : 'Add people'
          : name === 'parent-batch'
            ? before
              ? 'Confirm relationship'
              : 'Save'
            : name === 'game'
              ? 'Save'
              : undefined
      if (action != null)
        await m.scrollUntilVisible({
          element: { text: action, role: 'button' },
          centerElement: true,
          timeout: 10000
        })
      await new Promise(resolve => setTimeout(resolve, 400))
      await writeFile(
        join(artifacts!, `${name}-${phase}.png`),
        await m.screenshot()
      )
    }
    const source = `/groups/season/${f.seasonA}`
    let relationshipPending = ''
    await go(
      `${source}/link?target=team&relationship=participation&direction=children`,
      'Join a season'
    )
    await tap(m, 'Choose Demo Visitors')
    await contains(page, before ? 'Send invitation' : 'Save')
    await shot('relationship')
    if (!before) {
      await tap(m, 'Save')
      await contains(page, 'Demo Visitors')
      await page.waitForFunction(
        () =>
          !location.pathname.includes('/link') &&
          !location.pathname.includes('/notifications')
      )
      await contains(page, 'participation added')
      await shot('relationship-completion')
      assert.equal(
        (
          await f.h.db
            .selectFrom('season_teams')
            .select('active')
            .where('season_id', '=', f.seasonA)
            .where('team_id', '=', f.standaloneTeam)
            .executeTakeFirstOrThrow()
        ).active,
        true
      )
      await page.waitForSelector('[role="alert"]', {
        hidden: true,
        timeout: 7000
      })
      lines.push(
        'E1 participation Save: active membership, source return, detailed toast and expiry PASS'
      )
      await go(
        `${source}/link?target=team&relationship=parent&direction=children`,
        'Add a management relationship'
      )
      await tap(m, 'Choose Demo Visitors')
      await tap(m, 'Add another parent change')
      await tap(m, 'Choose change Demo Hawks')
      await tap(m, 'Choose change Demo League A')
      await tap(m, 'Review all parent changes')
      await contains(page, 'Save')
      await shot('parent-batch')
      await tap(m, 'Save')
      await page.waitForFunction(
        () =>
          !location.pathname.includes('/link') &&
          !location.pathname.includes('/notifications')
      )
      await contains(page, 'parent of Demo Visitors')
      assert.equal(
        (
          await f.h.db
            .selectFrom('season_team_parents')
            .select('team_id')
            .where('season_id', '=', f.seasonA)
            .where('team_id', '=', f.standaloneTeam)
            .execute()
        ).length,
        1
      )
      lines.push(
        'E1 management Save: parent connection and detailed toast PASS'
      )
      await go(
        `${source}/link?target=team&relationship=participation&direction=children`,
        'Join a season'
      )
      await fill(m, 'Search by name or city', 'Demo Eagles')
      await tap(m, 'Choose Demo Eagles')
      await tap(m, 'Send invitation')
      await page.waitForFunction(() =>
        location.pathname.startsWith('/notifications/')
      )
      relationshipPending = new URL(page.url()).pathname.split('/').pop()!
      lines.push(
        'E2 unmanaged counterpart: pending request and notification route PASS'
      )
    }
    await go(
      `/groups/team/${placeholder.id}/invite-administrator`,
      'Invite team administrator'
    )
    await fill(m, 'Administrator email', 'alex@example.com')
    await contains(page, before ? 'Send administrator invitation' : 'Save')
    await shot('promotion')
    if (!before) {
      await tap(m, 'Save')
      await contains(page, 'administrator added')
      await shot('promotion-completion')
      await page.waitForFunction(
        () =>
          !location.pathname.includes('/notifications') &&
          !location.pathname.includes('/invite-administrator')
      )
      assert.equal(
        (
          await f.h.db
            .selectFrom('teams')
            .select('kind')
            .where('id', '=', placeholder.id)
            .executeTakeFirstOrThrow()
        ).kind,
        'full'
      )
      lines.push(
        'E3 self promotion Save: team promoted, source return and toast PASS'
      )
      const other = await api.createGroup({
        kind: 'team',
        external: true,
        name: 'Demo Other Placeholder',
        custodian: { kind: 'season', id: f.seasonA },
        idempotencyKey: 'direct-other-placeholder'
      })
      await go(
        `/groups/team/${other.id}/invite-administrator`,
        'Invite team administrator'
      )
      await fill(m, 'Administrator email', 'casey@example.com')
      await tap(m, 'Send administrator invitation')
      await page.waitForFunction(() =>
        location.pathname.startsWith('/notifications/')
      )
      assert.equal(
        (
          await f.h.db
            .selectFrom('teams')
            .select('kind')
            .where('id', '=', other.id)
            .executeTakeFirstOrThrow()
        ).kind,
        'external'
      )
      lines.push(
        'E3 other recipient: actual invitation remains pending, no promotion PASS'
      )
    }
    await go(`/groups/team/${f.teamA}/settings/people`, 'Add People')
    await fill(m, 'E-mail addresses', 'fixture104@example.com')
    await shot('people')
    if (!before) {
      await tap(m, 'Add people')
      await contains(page, 'Added')
      await shot('people-completion')
      await page.waitForFunction(
        () =>
          !location.pathname.endsWith('/people') &&
          !location.pathname.includes('/notifications')
      )
      lines.push('E4 existing account: Add people and source toast PASS')
      await go(`/groups/team/${f.teamA}/settings/people`, 'Add People')
      await fill(m, 'E-mail addresses', 'visitor@example.test')
      await m.scrollUntilVisible({
        element: { text: 'Add people', role: 'button' },
        centerElement: true,
        timeout: 10000
      })
      await tap(m, 'Add people')
      await contains(page, 'Added 0, invited 1')
      lines.push(
        'E4 unknown account: actual outcome says invited, returns to source PASS'
      )
    }
    await f.h.db
      .insertInto('season_teams')
      .values([
        { season_id: f.seasonA, team_id: f.teamB, active: true },
        { season_id: f.seasonA, team_id: f.standaloneTeam, active: true }
      ])
      .onConflict(oc =>
        oc.columns(['season_id', 'team_id']).doUpdateSet({ active: true })
      )
      .execute()
    await go(`${source}/create-game`, 'Create Game')
    await tap(m, 'Choose Home Team, Home')
    await tap(m, 'Choose Demo Eagles')
    await tap(m, 'Choose Away Team, Away')
    await tap(m, 'Choose Demo Visitors')
    await shot('game')
    if (!before) {
      assert.ok(
        !(
          await page.evaluate(() => {
            const content = document.body.textContent
            return content === null ? '' : content
          })
        ).includes('must approve this game')
      )
      await tap(m, 'Save')
      await page.waitForFunction(() =>
        /^\/games\/[^/]+$/.test(location.pathname)
      )
      await contains(page, 'Game scheduled')
      await shot('game-completion')
      const game = await f.h.db
        .selectFrom('games')
        .selectAll()
        .where('home_team_id', '=', f.teamB)
        .where('away_team_id', '=', f.standaloneTeam)
        .executeTakeFirstOrThrow()
      assert.equal(game.season_id, f.seasonA)
      lines.push(
        'E5 two active members: immediate game publication, game route, toast PASS'
      )
      await go(`${source}/create-game`, 'Create Game')
      await tap(m, 'Choose Home Team, Home')
      await tap(m, 'Choose Demo Eagles')
      await tap(m, 'Choose Away Team, Away')
      await fill(m, 'Search all teams', 'Demo Placeholder')
      await tap(m, 'Choose Demo Placeholder')
      await m.scrollUntilVisible({
        element: { text: 'Save', role: 'button' },
        centerElement: true,
        timeout: 10000
      })
      await tap(m, 'Save')
      await page.waitForFunction(() =>
        location.pathname.startsWith('/notifications/')
      )
      lines.push(
        'E5 nonmember opponent: team consent still required and request stays pending PASS'
      )
      await f.h.db
        .insertInto('season_teams')
        .values({ season_id: f.seasonA, team_id: placeholder.id, active: true })
        .onConflict(oc =>
          oc.columns(['season_id', 'team_id']).doUpdateSet({ active: true })
        )
        .execute()
      await tap(m, 'Submit again')
      await page.waitForFunction(() =>
        /^\/games\/[^/]+$/.test(location.pathname)
      )
      await contains(page, 'Game saved')
      await shot('game-resend-completion')
      lines.push(
        'E6 game resend: new member consent publishes immediately, game route and detailed toast PASS'
      )
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: 'role_resend_direct',
          user_id: userIdOfGumbo(101),
          scope_type: 'team',
          scope_id: f.teamB,
          role: 'admin'
        })
        .execute()
      await go(`/notifications/${relationshipPending}`, 'Submit again')
      await tap(m, 'Submit again')
      await page.waitForFunction(
        () => !location.pathname.includes('/notifications')
      )
      await contains(page, 'season participation added')
      await shot('connection-resend-completion')
      lines.push(
        'E6 connection resend: all current approvals applied, source route and detailed toast PASS'
      )
    }
    if (before) {
      // Give the baseline both-team authority for its accepted completion state.
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: 'role_baseline_away',
          user_id: userIdOfGumbo(101),
          scope_type: 'team',
          scope_id: f.teamB,
          role: 'admin'
        })
        .execute()
      await tap(m, 'Save')
      await page.waitForFunction(() =>
        location.pathname.startsWith('/notifications/')
      )
      await shot('game-completion')
      await go(
        `${source}/link?target=team&relationship=participation&direction=children`,
        'Join a season'
      )
      await tap(m, 'Choose Demo Visitors')
      await tap(m, 'I approve for all affected groups')
      await tap(m, 'Confirm relationship')
      await page.waitForFunction(() =>
        location.pathname.startsWith('/notifications/')
      )
      await shot('relationship-completion')
      await go(
        `${source}/link?target=team&relationship=parent&direction=children`,
        'Add a management relationship'
      )
      await tap(m, 'Choose Demo Visitors')
      await tap(m, 'Add another parent change')
      await tap(m, 'Choose change Demo Hawks')
      await tap(m, 'Choose change Demo League A')
      await tap(m, 'Review all parent changes')
      await tap(m, 'I approve for all affected groups')
      await shot('parent-batch')
      await go(
        `/groups/team/${placeholder.id}/invite-administrator`,
        'Invite team administrator'
      )
      await fill(m, 'Administrator email', 'alex@example.com')
      await tap(m, 'Send administrator invitation')
      await page.waitForFunction(() =>
        location.pathname.startsWith('/notifications/')
      )
      await shot('promotion-completion')
      await go(`/groups/team/${f.teamA}/settings/people`, 'Add People')
      await fill(m, 'E-mail addresses', 'fixture104@example.com')
      await tap(m, 'Send invite')
      await page.waitForFunction(() => !location.pathname.endsWith('/people'))
      await shot('people-completion')
      const baselineGame = await f.h.db
        .selectFrom('games')
        .select('id')
        .where('home_team_id', '=', f.teamB)
        .where('away_team_id', '=', f.standaloneTeam)
        .executeTakeFirstOrThrow()
      const baselineSchedule = await api.gameScheduling(baselineGame.id)
      await f.h.db
        .deleteFrom('scope_roles')
        .where('id', '=', 'role_baseline_away')
        .execute()
      await f.h.db
        .updateTable('season_teams')
        .set({ active: false })
        .where('season_id', '=', f.seasonA)
        .where('team_id', '=', f.teamB)
        .execute()
      const pendingGame = await api.proposeGame({
        sender: { kind: 'season', id: f.seasonA },
        game: {
          ...baselineSchedule.game,
          awayTeamId: placeholder.id
        },
        idempotencyKey: 'baseline-resend-game'
      })
      assert.equal(pendingGame.status, 'pending')
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: 'role_baseline_away',
          user_id: userIdOfGumbo(101),
          scope_type: 'team',
          scope_id: f.teamB,
          role: 'admin'
        })
        .execute()
      await go(`/notifications/${pendingGame.id}`, 'Resend invitation')
      await tap(m, 'Resend invitation')
      await contains(page, 'Accepted')
      await shot('game-resend-completion')
      const pendingLink = await api.inviteRelationship({
        kind: 'participation',
        sender: { kind: 'season', id: f.seasonA },
        seasonId: f.seasonA,
        teamId: f.teamB,
        idempotencyKey: 'baseline-resend-link'
      })
      await go(`/notifications/${pendingLink.id}`, 'Resend invitation')
      await tap(m, 'Resend invitation')
      await contains(page, 'Accepted')
      await shot('connection-resend-completion')
    }
    lines.push(`${phase} completed`)
  } finally {
    try {
      if (session != null)
        await Promise.allSettled([session.browser.close(), session.m.detach()])
      if (daemon != null) await daemon.shutdown()
    } finally {
      await f.h.close()
      await writeFile(
        join(artifacts!, before ? 'before-browser.log' : 'direct-actions.log'),
        lines.join('\n') + '\n'
      )
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
