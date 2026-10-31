import { expect } from 'chai'

import { defineE2e, type E2eContext } from '../../../core/spec'

/** Real RSVP eligibility, roster removal and write authorization, in Safari. */
async function rosterRemoval(ctx: E2eContext): Promise<void> {
  // Server code loads only when the scenario runs, so reading the spec has no side
  // effects.
  const { asEventInfo } = await import('../../../../src/common/eventInfo')
  const { makeId } = await import('../../../../src/common/ids')
  const { userIdOfGumbo } = await import('../../../../src/common/userId')
  const { guardianFixture } =
    await import('../../../../src/test/guardianFixture')
  if (ctx.stack.webDir == null)
    throw new Error('This scenario needs a web build')
  const f = await guardianFixture(ctx.stack.webDir)
  const origin = await ctx.stack.adopt(f.h.origin)
  const m = await ctx.attach('browser', {
    platform: 'ios',
    appId: 'com.apple.mobilesafari',
    commandTimeout: 30000
  })
  try {
    const user = f.people.teamCoach
    await f.h.db
      .updateTable('users')
      .set({ onboarding_step: 'complete', onboarding_completed_at: new Date() })
      .where('id', '=', userIdOfGumbo(user))
      .execute()
    const game = f.games[0]
    const child = f.players[0].id
    const outsider = f.people.oneTeam
    await f.h.db
      .updateTable('users')
      .set({
        first_name: 'Ken',
        last_name: 'Griffey',
        display_name: 'Ken Griffey'
      })
      .where('id', '=', userIdOfGumbo(outsider))
      .execute()
    for (const id of [child, outsider])
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(user),
          related_user_id: userIdOfGumbo(id),
          kind: 'guardian',
          can_manage: false
        })
        .execute()
    const info = asEventInfo(
      await (
        await f.h.request('GET', `/events/${game.id}/info`, undefined, user)
      ).json()
    )
    expect(info.replyUserIds)
      .includes(userIdOfGumbo(user))
      .and.includes(userIdOfGumbo(child))
      .and.not.includes(userIdOfGumbo(outsider))
    const childName = info.attendees.find(
      row => row.userId === userIdOfGumbo(child)
    )!.name
    const ownName = info.attendees.find(
      row => row.userId === userIdOfGumbo(user)
    )!.name
    const path = `/games/${game.id}?tab=info`
    await m.openLink({
      link: origin + '/sign-in?next=' + encodeURIComponent(path)
    })
    await m.assertVisible({ text: 'Sign in to TeamStation', timeout: 20000 })
    await m.waitForAnimationToEnd()
    await m.tapOn({ text: 'E-mail address' })
    await m.inputText({ text: f.emails[user] })
    await m.pressKey({ key: 'ENTER' })
    await m.assertVisible({ text: 'Sign-in code', timeout: 10000 })
    const link = f.h.links.get(f.emails[user])
    if (link == null) throw new Error('No sign-in link was sent')
    await m.openLink({ link: origin + new URL(link).pathname })
    await m.assertVisible({ text: 'RSVP', timeout: 20000 })
    await m.waitForAnimationToEnd()
    await ctx.checkpoint('rsvp-card', { expect: [{ text: 'RSVP' }] })
    await m.tapOn({ text: 'RSVP' })
    await m.assertVisible({ text: childName })
    await m.assertVisible({ text: ownName })
    await m.assertNotVisible({ text: 'Ken G' })
    await m.waitForAnimationToEnd()
    await ctx.checkpoint('rsvp-list', {
      expect: [
        { text: childName },
        { text: ownName },
        { text: 'Ken G', absent: true }
      ],
      golden: {}
    })
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(child))
      .where('team_id', '=', f.teamA)
      .execute()
    const rejected = await f.h.request(
      'PUT',
      `/events/${game.id}/rsvps/${userIdOfGumbo(child)}`,
      { response: 'yes' },
      user
    )
    expect(rejected.status).equals(403)
    await m.openLink({ link: origin + path })
    await m.assertVisible({ text: 'RSVP', timeout: 20000 })
    await m.tapOn({ text: 'RSVP' })
    await m.assertVisible({ text: ownName })
    await m.assertNotVisible({ text: childName })
    await m.waitForAnimationToEnd()
    await ctx.checkpoint('rsvp-after-removal', {
      expect: [{ text: ownName }, { text: childName, absent: true }],
      golden: {},
      readBack: async () => {
        const stored = asEventInfo(
          await (
            await f.h.request('GET', `/events/${game.id}/info`, undefined, user)
          ).json()
        )
        expect(stored.replyUserIds).not.includes(userIdOfGumbo(child))
      }
    })
  } finally {
    await f.h.close()
  }
}

export default defineE2e({
  id: 'schedule/rsvp/eligibility',
  title: 'RSVP lists only eligible people, and follows a roster removal',
  kind: 'e2e',
  covers: [
    'src/server/routes/events.ts',
    'src/app/screens/**',
    'src/common/eventInfo.ts'
  ],
  stack: 'isolated',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      devices: [{ role: 'browser', needs: ['ios-phone'], hardware: 'none' }]
    }
  },
  services: ['web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: ['api-500', 'api-hang', 'api-garbage', 'wrong-data'],
  manual: false,
  scenarios: { 'roster-removal': rosterRemoval }
})
