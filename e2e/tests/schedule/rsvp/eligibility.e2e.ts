import { expect } from 'chai'

import type { FixtureAccount } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import {
  defineHarness,
  type HarnessContext,
  type StackControl
} from '../../../core/spec'

/** The stack's API as one account, signed in with its password as the app does. */
async function apiAs(
  ctx: HarnessContext,
  account: FixtureAccount
): Promise<
  (method: string, path: string, body?: unknown) => Promise<Response>
> {
  const { TeamStationClient } = await import('../../../../src/common/api')
  const { passwordBytes } =
    await import('../../../../src/common/passwordProtocol')
  const { nativeArgon } = await import('../../../../src/server/auth/passwords')
  const api = `${ctx.stack.origin.replace(/\/+$/, '')}/api/v1`
  const client = new TeamStationClient({
    baseUrl: api,
    passwordKdf: async (password: string, parameters: any) =>
      await nativeArgon(passwordBytes(password), parameters)
  })
  const { token } = await client.signInWithPassword(
    account.email,
    account.password
  )
  return async (method, path, body) =>
    await fetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
}

function controlOf(ctx: HarnessContext): StackControl {
  const control = ctx.stack.control
  if (control == null) {
    throw new BlockedError(
      "this stack has no control routes to set the guardians' links up with"
    )
  }
  return control
}

/** Real RSVP eligibility, roster removal and write authorization, in Safari. */
async function rosterRemoval(ctx: HarnessContext): Promise<void> {
  // Server code loads only when the scenario runs, so reading the spec has no side
  // effects.
  const { asEventInfo } = await import('../../../../src/common/eventInfo')
  const { makeId } = await import('../../../../src/common/ids')
  const control = controlOf(ctx)
  // Three teams of their own: the outsider plays on one the game is not,
  // the visitors are the game's other side, and the last world's coach is
  // the guardian who signs in.
  const elsewhere = await ctx.fixture('team-with-roster')
  const visitors = await ctx.fixture('team-with-roster')
  const home = await ctx.fixture('team-with-roster')
  const coach = home.accounts.coach
  const child = home.accounts.player.userId
  const outsider = elsewhere.accounts.player.userId
  const team = home.ids.team
  await control.sql(
    'UPDATE users SET onboarding_step = $2, onboarding_completed_at = now() WHERE id = $1',
    [coach.userId, 'complete']
  )
  await control.sql(
    'UPDATE users SET first_name = $2, last_name = $3, display_name = $4 WHERE id = $1',
    [outsider, 'Ken', 'Griffey', 'Ken Griffey']
  )
  for (const related of [child, outsider]) {
    await control.sql(
      'INSERT INTO user_links (id, user_id, related_user_id, kind, can_manage) VALUES ($1, $2, $3, $4, false)',
      [makeId('userLink'), coach.userId, related, 'guardian']
    )
  }
  const game = { id: `gam_rsvp_${home.nonce}` }
  await control.sql(
    `INSERT INTO games (id, home_team_id, away_team_id, start_at, venue, status, home_score, away_score, timezone)
     VALUES ($1, $2, $3, $4, 'Demo Field', 'final', 6, 3, 'UTC')`,
    [game.id, team, visitors.ids.team, '2026-09-20T18:00:00Z']
  )
  const request = await apiAs(ctx, coach)
  const info = asEventInfo(
    await (await request('GET', `/events/${game.id}/info`)).json()
  )
  expect(info.replyUserIds)
    .includes(coach.userId)
    .and.includes(child)
    .and.not.includes(outsider)
  const childName = info.attendees.find(row => row.userId === child)!.name
  const ownName = info.attendees.find(row => row.userId === coach.userId)!.name
  const path = `/games/${game.id}?tab=info`
  const origin = ctx.stack.origin.replace(/\/+$/, '')
  const m = await ctx.mobileBrowser('browser', `${origin}/sign-in`)
  await ctx.signIn('coach', m)
  await m.openLink({ link: origin + path, browser: true })
  await m.assertVisible({ text: 'RSVP', timeout: 20000 })
  await m.waitForAnimationToEnd()
  await ctx.checkpoint('rsvp-card', { expect: [{ text: 'RSVP' }] })
  await m.tapOn({ text: 'RSVP' })
  await m.assertVisible({ text: childName })
  await m.assertVisible({ text: ownName })
  // The coach is Ken's guardian, so would read him in full.
  await m.assertNotVisible({ text: 'Ken Griffey' })
  await m.waitForAnimationToEnd()
  await ctx.checkpoint('rsvp-list', {
    expect: [
      { text: childName },
      { text: ownName },
      { text: 'Ken Griffey', absent: true }
    ]
  })
  await control.sql(
    'DELETE FROM memberships WHERE user_id = $1 AND team_id = $2',
    [child, team]
  )
  const rejected = await request('PUT', `/events/${game.id}/rsvps/${child}`, {
    response: 'yes'
  })
  expect(rejected.status).equals(403)
  await m.openLink({ link: origin + path, browser: true })
  await m.assertVisible({ text: 'RSVP', timeout: 20000 })
  await m.tapOn({ text: 'RSVP' })
  await m.assertVisible({ text: ownName })
  await m.assertNotVisible({ text: childName })
  await m.waitForAnimationToEnd()
  await ctx.checkpoint('rsvp-after-removal', {
    expect: [{ text: ownName }, { text: childName, absent: true }],
    readBack: async () => {
      const stored = asEventInfo(
        await (await request('GET', `/events/${game.id}/info`)).json()
      )
      expect(stored.replyUserIds).not.includes(child)
    }
  })
}

export default defineHarness({
  id: 'schedule/rsvp/eligibility',
  title: 'RSVP lists only eligible people, and follows a roster removal',
  kind: 'e2e',
  covers: [
    'src/server/routes/events.ts',
    'src/app/screens/**',
    'src/common/eventInfo.ts'
  ],
  stack: 'isolated',
  fixtures: ['team-with-roster'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      devices: [{ role: 'browser', needs: ['ios-phone'], simulator: 'allowed' }]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: ['api-500', 'api-hang', 'api-garbage', 'wrong-data'],
  manual: false,
  scenarios: { 'roster-removal': rosterRemoval }
})
