import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { asEventInfo } from '../../common/eventInfo'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { guardianFixture } from '../../test/guardianFixture'
import { capture, maestro } from '../../test/refinementsMaestro.e2e'

/** Real RSVP eligibility, roster removal and write authorization in Safari on a simulator only. */
async function main(): Promise<void> {
  const device = process.env.TS_SIMULATOR_UDID
  const out = process.env.TS_ARTIFACTS_DIR
  if (device == null || out == null)
    throw new Error('Supply simulator and artifact directory')
  const inventory = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf8'
    })
  ) as { devices: Record<string, Array<{ udid: string }>> }
  if (
    !Object.values(inventory.devices)
      .flat()
      .some(sim => sim.udid === device)
  )
    throw new Error('A booted iOS simulator is required')
  await mkdir(out, { recursive: true })
  const f = await guardianFixture(resolve('dist'))
  const d = await maestro('rsvp-eligibility-simulator')
  const m = await d.attach({
    device,
    platform: 'ios',
    appId: 'com.apple.mobilesafari',
    artifacts: 'on-failure',
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
      link: f.h.origin + '/sign-in?next=' + encodeURIComponent(path)
    })
    await m.tapOn({ text: 'E-mail address' })
    await m.inputText({ text: f.emails[user] })
    await m.pressKey({ key: 'ENTER' })
    await m.assertVisible({ text: 'Sign-in code', timeout: 10000 })
    const link = f.h.links.get(f.emails[user])!
    await m.openLink({ link: f.h.origin + new URL(link).pathname })
    await m.assertVisible({ text: 'RSVP', timeout: 20000 })
    await capture(m, out, 'eligible-rsvp-card.png')
    await m.tapOn({ text: 'RSVP' })
    await m.assertVisible({ text: childName })
    await m.assertVisible({ text: ownName })
    await m.assertNotVisible({ text: 'Ken G' })
    await capture(m, out, 'eligible-rsvp-modal.png')
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(child))
      .where('team_id', '=', f.teamA)
      .execute()
    const rejected = await f.h.request(
      'PUT',
      `/events/${game.id}/rsvps/${child}`,
      { response: 'yes' },
      user
    )
    expect(rejected.status).equals(403)
    await m.openLink({ link: f.h.origin + path })
    await m.assertVisible({ text: 'RSVP', timeout: 20000 })
    await m.tapOn({ text: 'RSVP' })
    await m.assertVisible({ text: ownName })
    await m.assertNotVisible({ text: childName })
    await capture(m, out, 'removed-player-rsvp.png')
    console.log(
      'PASS simulator RSVP card/modal excludes unrelated children; roster removal refreshes eligibility and rejects writes'
    )
  } catch (error) {
    await writeFile(
      join(out, 'failure-hierarchy.json'),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
    await capture(m, out, 'failure.png')
    throw error
  } finally {
    await m.detach()
    await d.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
