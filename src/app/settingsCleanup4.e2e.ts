/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Serialized browser callbacks cannot capture compiler helpers. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { Page } from 'puppeteer'

import {
  browserSession,
  contains,
  fill,
  maestro
} from '../../e2e/rigs/refinementsMaestro'
import { TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { groupFixture } from '../test/groupFixtures'
import { insertFixtureUsers } from '../test/insertFixtureUsers'
import { seedSettingsCleanup3 } from '../test/settingsCleanup3Fixture'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_CREATION_ARTIFACTS')
const before = process.argv.includes('--before')
const phase = before ? 'before' : 'after'
async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const f = await groupFixture(
    resolve(process.env.TS_RELATIONSHIP_WEB_ROOT ?? 'dist')
  )
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let session: Awaited<ReturnType<typeof browserSession>> | undefined
  const lines = [
    `$ node -r sucrase/register src/app/settingsCleanup4.e2e.ts ${before ? '--before' : ''}`
  ]
  try {
    await seedSettingsCleanup3(f)
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
    const long = await api.createGroup({
      kind: 'team',
      name: 'Willow Woods Westward Wanderers',
      external: true,
      custodian: { kind: 'season', id: f.seasonA },
      idempotencyKey: 'rows-long-team'
    })
    for (const team of [f.standaloneTeam, long.id])
      await f.h.db
        .insertInto('season_teams')
        .values({ season_id: f.seasonA, team_id: team, active: true })
        .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_rows_player',
        user_id: userIdOfGumbo(106),
        team_id: f.teamA,
        is_player: true
      })
      .execute()
    await insertFixtureUsers(f.h.db, {
      id: 107,
      legacyId: 'usr_rows_107',
      display_name: 'Mookie Betts',
      first_name: 'Mookie',
      last_name: 'Betts',
      login_enabled: false,
      is_admin: false
    })
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_rows_no_email',
        user_id: userIdOfGumbo(107),
        team_id: f.teamA,
        is_player: true
      })
      .execute()
    await api.addRole('team', f.teamA, userIdOfGumbo(106), 'coach')
    const firstLink = await api.createInvite({
      scopeType: 'team',
      scopeId: f.teamA,
      code: 'demorowsone',
      label: 'Families'
    })
    await api.createInvite({
      scopeType: 'team',
      scopeId: f.teamA,
      code: 'demorowstwo',
      label: 'Guests'
    })
    await api.addPerson('team', f.teamA, 'first-invite@example.com')
    await api.addPerson('team', f.teamA, 'second-invite@example.com')
    const pendingSeeds = (await api.managePage('team', f.teamA)).pending
    for (const [index, address] of [
      'first-invite@example.com',
      'second-invite@example.com'
    ].entries()) {
      const pending = pendingSeeds.find(row => row.email === address)!
      await f.h.db
        .updateTable('invites')
        .set({
          code: index === 0 ? 'demopendingfirst' : 'demopendingsecond',
          created_at: new Date(`2026-10-0${index + 3}T00:00:00Z`)
        })
        .where('id', '=', pending.inviteId)
        .execute()
    }
    for (const [index, label] of ['Families', 'Guests'].entries())
      await f.h.db
        .updateTable('invites')
        .set({ created_at: new Date(`2026-10-0${index + 1}T00:00:00Z`) })
        .where('label', '=', label)
        .where('scope_id', '=', f.teamA)
        .execute()

    daemon = await maestro(`settings4-${phase}-${process.pid}`)
    session = await browserSession(
      daemon,
      `settings4-${phase}-${process.pid}`,
      402,
      874,
      artifacts!,
      'chrome'
    )
    const { m, page, browser } = session
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    const go = async (path: string, wanted: string): Promise<void> => {
      await m.openLink({ link: f.h.origin + path })
      await contains(page, wanted)
      await page.waitForNetworkIdle({ idleTime: 150, timeout: 15000 })
    }
    const show = async (label: string): Promise<void> => {
      for (let i = 0; i < 15; i++) {
        const at = await page.evaluate(label => {
          const nodes = [...document.querySelectorAll<HTMLElement>('*')]
          const named = nodes.find(
            node =>
              node.getAttribute('role') === 'button' &&
              (node.getAttribute('aria-label') === label ||
                node.textContent === label)
          )
          const node =
            named == null
              ? nodes.find(
                  node =>
                    node.children.length === 0 && node.textContent === label
                )
              : named
          if (node == null) throw new Error('Missing scroll target ' + label)
          const r = node.getBoundingClientRect()
          return {
            top: r.top,
            bottom: r.bottom,
            height: innerHeight,
            modal: node.closest('[aria-modal="true"], [role="dialog"]') != null
          }
        }, label)
        if (
          at.top > (at.modal ? 0 : 90) &&
          at.bottom < at.height - (at.modal ? 8 : 100)
        )
          return
        await m.command('scroll', { direction: at.top < 90 ? 'UP' : 'DOWN' })
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      throw new Error('Scroll target inaccessible ' + label)
    }
    const tap = async (label: string): Promise<void> => {
      await show(label)
      await m.tapOn({ text: label, role: 'button', timeout: 15000 })
      await new Promise(resolve => setTimeout(resolve, 350))
    }
    const shot = async (name: string): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 400))
      await writeFile(
        join(artifacts!, `${name}-${phase}.png`),
        await m.screenshot()
      )
      lines.push(`Captured ${name}-${phase}.png`)
    }
    if (process.argv.includes('--capture-node')) {
      await go('/node', 'Node administration')
      await shot('node-access')
      return
    }
    const membership = async (season: string, team: string): Promise<boolean> =>
      (
        await f.h.db
          .selectFrom('season_teams')
          .select('active')
          .where('season_id', '=', season)
          .where('team_id', '=', team)
          .executeTakeFirstOrThrow()
      ).active
    await go(`/groups/season/${f.seasonA}/settings`, 'PARTICIPATING TEAMS')
    await show('End participation for Winter Wolves')
    await shot('season-participants')
    if (before) await shot('season-confirm')
    else {
      await tap('End participation for Winter Wolves')
      await contains(
        page,
        'End participation for Winter Wolves in Winter Weekends?'
      )
      await shot('season-confirm')
      assert(await membership(f.seasonA, f.teamA))
      await tap('Cancel')
      assert(await membership(f.seasonA, f.teamA))
      await tap('End participation for Winter Wolves')
      await m.pressKey({ key: 'ESCAPE' })
      await page.waitForSelector('[aria-label="Confirm end participation"]', {
        hidden: true
      })
      assert(await membership(f.seasonA, f.teamA))
      await tap('End participation for Winter Wolves')
      await tap('Confirm end participation')
      assert.equal(await membership(f.seasonA, f.teamA), false)
      assert(await membership(f.seasonA, f.standaloneTeam))
      assert.equal(
        (await api.group({ kind: 'team', id: f.teamA })).parents.length,
        2
      )
      assert.equal(
        (await api.group({ kind: 'season', id: f.seasonA })).games.length,
        3
      )
      await f.h.db
        .updateTable('season_teams')
        .set({ active: true })
        .where('season_id', '=', f.seasonA)
        .where('team_id', '=', f.teamA)
        .execute()
      lines.push(
        'E1 PASS: confirmed selected End, Cancel mutation-free, other memberships/games/parents preserved'
      )
    }
    await go(`/groups/team/${f.teamA}/settings`, 'SEASON PARTICIPATIONS')
    await show('Leave season Winter Weekends')
    await shot('team-relationships')
    if (!before) {
      await tap('Leave season Spring Playoffs')
      await tap('Cancel')
      assert(await membership(f.playoffs, f.teamA))
      await tap('Leave season Spring Playoffs')
      await tap('Leave Spring Playoffs')
      assert.equal(await membership(f.playoffs, f.teamA), false)
      await f.h.db
        .updateTable('season_teams')
        .set({ active: true })
        .where('season_id', '=', f.playoffs)
        .where('team_id', '=', f.teamA)
        .execute()
      lines.push(
        'E2 PASS: team-side Leave confirmed independently, no write on Cancel'
      )
      await go(`/groups/team/${f.teamA}/settings`, 'MANAGE PLAYERS')
    }
    await show('Remove Tim Raines')
    await shot('manage-players')
    await tap('Remove Ichiro')
    await contains(page, 'Remove Ichiro from Winter Wolves?')
    await shot('player-removal-confirm')
    await tap('Cancel')
    if (!before) {
      assert(
        (await api.roster(f.teamA)).some(
          row => row.userId === userIdOfGumbo(104)
        )
      )
      await tap('Remove Ichiro')
      await m.tapOn({
        css: '[role="dialog"] [data-testid="settings-pill-button"]',
        timeout: 10000
      })
      await page.waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
      assert(
        !(await api.roster(f.teamA)).some(
          row => row.userId === userIdOfGumbo(104)
        )
      )
      await f.h.db
        .deleteFrom('memberships')
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', userIdOfGumbo(104))
        .execute()
      await f.h.db
        .insertInto('memberships')
        .values({
          id: 'mem_settings3_player',
          user_id: userIdOfGumbo(104),
          team_id: f.teamA,
          is_player: true
        })
        .execute()
      lines.push(
        'E5 players PASS: all players include no-email account; Cancel then confirmed selected removal and fixture restored'
      )
    }
    await go(
      `/groups/league/${f.leagueA}?tab=seasons`,
      'Demo Playoffs'.replace('Demo Playoffs', 'Spring Playoffs')
    )
    await shot('league-seasons')
    await go(`/groups/league/${f.leagueA}?tab=teams`, 'Winter Wolves')
    await shot('league-teams')
    if (before) {
      await tap('More for Winter Wolves')
      await tap('Break parent relationship')
    } else await tap('Leave Winter Wolves from Willow Woods')
    await contains(page, 'Review relationship changes')
    await shot('league-parent-confirm')
    await tap(before ? 'Keep relationship' : 'Cancel')
    assert.equal(
      (await api.group({ kind: 'team', id: f.teamA })).parents.length,
      2
    )
    if (!before) {
      await tap('Open Winter Wolves')
      await contains(page, 'Winter Wolves')
      await page.waitForFunction(() => location.pathname.includes('/team/'))
      lines.push(
        'E3 PASS: league child row opens team, parent preview cancel keeps both links'
      )
    }
    await go(`/groups/season/${f.seasonA}?tab=teams`, 'Winter Wolves')
    await shot('season-teams')
    if (before) {
      await tap('More for Winter Wolves')
      await tap('Break parent relationship')
    } else await tap('Leave Winter Wolves from Winter Weekends')
    await contains(page, 'Review relationship changes')
    await shot('season-parent-confirm')
    await tap(before ? 'Keep relationship' : 'Cancel')
    if (!before) {
      await tap('Leave Winter Wolves from Winter Weekends')
      await tap('Break relationship')
      assert(
        !(await api.group({ kind: 'team', id: f.teamA })).parents.some(
          parent => parent.id === f.seasonA
        )
      )
      const preview = await api.parentPreview([
        {
          operation: 'attach',
          child: { kind: 'team', id: f.teamA },
          parent: { kind: 'season', id: f.seasonA }
        }
      ])
      await api.changeParents(preview)
      lines.push(
        'E4 PASS: season row preview cancel and confirmed selected parent removal, then fixture restored'
      )
    }
    if (!before) {
      await browser.setCookie({
        name: SESSION_COOKIE,
        value: f.h.tokens.get(102)!,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true
      })
      await go(`/groups/season/${f.seasonA}?tab=teams`, 'Winter Wolves')
      assert.equal(
        await page.$('[aria-label="Leave Winter Wolves from Winter Weekends"]'),
        null
      )
      await browser.setCookie({
        name: SESSION_COOKIE,
        value: f.h.tokens.get(101)!,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true
      })
      lines.push(
        'Read-only season visitor PASS: no relationship removal control'
      )
    }
    if (process.argv.includes('--groups-only')) return
    await go('/node', 'Node administration')
    await shot('node-access')
    if (!before) {
      await fill(m, 'Find an account', 'fixture106')
      await contains(page, 'Tim Raines')
      await tap('Add Tim Raines')
      await tap('Revoke Tim Raines')
      await contains(page, 'Revoke node access for Tim Raines?')
      await tap('Cancel')
      await tap('Revoke Tim Raines')
      await tap('Confirm revoke')
      lines.push(
        'E5 node PASS: Add, canceled and confirmed Revoke; mail above access retained'
      )
    }
    await go(`/groups/team/${f.teamA}/settings/invites`, 'Families')
    await shot('invite-links')
    if (before) await shot('disable-link-confirm')
    else {
      await tap('Copy the invite link demorowsone')
      await contains(page, 'Copied')
      await tap('Create invite link')
      await tap('Cancel')
      await tap('Disable invite link Families')
      await contains(page, 'Disable Families for Winter Wolves?')
      await shot('disable-link-confirm')
      await tap('Cancel')
      assert.equal(
        (await api.invites('team', f.teamA)).invites.find(
          row => row.id === firstLink.id
        )?.problem,
        null
      )
      await tap('Disable invite link Families')
      await tap('Confirm disable')
      assert.notEqual(
        (await api.invites('team', f.teamA)).invites.find(
          row => row.id === firstLink.id
        )?.problem,
        null
      )
      lines.push(
        'E6 PASS: Disable confirmation, cancel then selected revoke; other link retained'
      )
    }
    await go(`/groups/team/${f.teamA}/settings`, 'INVITATIONS WAITING')
    await m.command('scroll', { direction: 'DOWN' })
    await contains(page, 'first-invite@example.com')
    await shot('invitations')
    if (before) await shot('withdraw-invite-confirm')
    else {
      await tap('Withdraw invitation to first-invite@example.com')
      await contains(page, 'Withdraw invitation to first-invite@example.com?')
      await shot('withdraw-invite-confirm')
      await tap('Cancel')
      assert(
        (await api.managePage('team', f.teamA)).pending.some(
          row => row.email === 'first-invite@example.com'
        )
      )
      await tap('Withdraw invitation to first-invite@example.com')
      await tap('Confirm withdrawal')
      assert(
        !(await api.managePage('team', f.teamA)).pending.some(
          row => row.email === 'first-invite@example.com'
        )
      )
      assert(
        (await api.managePage('team', f.teamA)).pending.some(
          row => row.email === 'second-invite@example.com'
        )
      )
      lines.push(
        'E7 PASS: selected invitation confirmation, Cancel/no write, withdraw keeps other invitation'
      )
    }
    await go(`/teams/${f.teamA}/people/106`, 'Tim Raines')
    await show('Coach')
    if (!before) {
      await m.tapOn({ text: 'Coach', role: 'switch' })
      await contains(page, 'Remove Coach from Tim Raines')
    }
    await shot('role-removal')
    if (!before) {
      await tap('Cancel')
      assert(
        (await api.personProfile('team', f.teamA, userIdOfGumbo(106))).sections
          .find(row => row.level === 'team')!
          .roles.includes('coach')
      )
      await m.tapOn({ text: 'Coach', role: 'switch' })
      await tap('Confirm removal')
      assert(
        !(await api.personProfile('team', f.teamA, userIdOfGumbo(106))).sections
          .find(row => row.level === 'team')!
          .roles.includes('coach')
      )
      lines.push(
        'E8 PASS: actual selected role consent, Cancel no mutation, confirmed remove'
      )
      await insertFixtureUsers(f.h.db, {
        id: 108,
        legacyId: 'usr_rows_108',
        display_name: 'Willie Mays',
        first_name: 'Willie',
        last_name: 'Mays',
        login_enabled: true,
        is_admin: false
      })
      await f.h.db
        .insertInto('memberships')
        .values({
          id: 'mem_rows_final',
          user_id: userIdOfGumbo(108),
          team_id: f.teamA,
          role: 'member',
          is_player: false
        })
        .execute()
      await go(`/teams/${f.teamA}/people/108`, 'Willie Mays')
      await show('Member')
      await m.tapOn({ text: 'Member', role: 'switch' })
      await tap('Confirm removal')
      await contains(
        page,
        'Change saved. This person is no longer available in this group.'
      )
      assert.equal(await page.$('[aria-label="Confirm removal"]'), null)
      assert.equal(await page.$('[role="switch"]'), null)
      await assert.rejects(
        api.personProfile('team', f.teamA, userIdOfGumbo(108)),
        {
          code: 'notFound'
        }
      )
      await shot('final-membership-removed')
      lines.push(
        'E8 final membership PASS: successful removal followed by expected404 closes confirmation and clears stale controls'
      )
    }
    await page.setViewport({ width: 320, height: 874 })
    await go(`/groups/season/${f.seasonA}/settings`, 'PARTICIPATING TEAMS')
    await show('End participation for Willow Woods Westward Wanderers')
    await shot('narrow-participants')
    if (!before) await checkRows(page)
    lines.push(`${phase} browser pass complete`)
  } catch (error) {
    if (session != null) {
      await writeFile(
        join(artifacts!, `failure-${phase}.png`),
        await session.m.screenshot()
      ).catch(() => undefined)
      await writeFile(
        join(artifacts!, `failure-${phase}.txt`),
        await session.page.evaluate(() => document.body.innerText)
      ).catch(() => undefined)
    }
    throw error
  } finally {
    if (session != null) {
      await session.browser.disconnect()
      await session.m.detach().catch(() => undefined)
    }
    if (daemon != null) await daemon.shutdown()
    await f.h.close()
    lines.push('Owned browser/daemon/API/DB closed')
    await writeFile(
      join(
        artifacts!,
        before
          ? 'before-browser.log'
          : process.argv.includes('--capture-node')
            ? 'node-capture.log'
            : 'browser.log'
      ),
      lines.join('\n') + '\n'
    )
  }
}
async function checkRows(page: Page): Promise<void> {
  const rows = await page.$$eval(
    '[data-testid="relationship-action-row"]',
    nodes =>
      nodes.map(node => {
        const action = node.querySelector<HTMLElement>(
          '[role="button"]:last-child'
        )
        const bounds = action == null ? null : action.getBoundingClientRect()
        return {
          width: bounds == null ? 0 : bounds.width,
          height: bounds == null ? 0 : bounds.height,
          right: bounds == null ? 0 : bounds.right,
          screen: innerWidth
        }
      })
  )
  assert(rows.length >= 3)
  for (const row of rows) {
    assert(row.width >= 48)
    assert(row.height >= 48)
    assert(row.right <= row.screen)
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
