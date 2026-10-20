import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { userIdOfGumbo } from '../../common/userId'
import { guardianFixture } from '../../test/guardianFixture'
import { capture, maestro } from '../../test/refinementsMaestro.e2e'
import { parseRoute, routePath } from '../navigation/routes'

/** Safari on an explicitly selected simulator; never attaches to hardware. */
async function main(): Promise<void> {
  const device = process.env.TS_SIMULATOR_UDID
  const out = process.env.TS_ARTIFACTS_DIR
  if (device == null || out == null)
    throw new Error('Supply TS_SIMULATOR_UDID and TS_ARTIFACTS_DIR')
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
    throw new Error('The requested device must be a booted iOS simulator')
  await mkdir(out, { recursive: true })
  const f = await guardianFixture(resolve('dist'))
  const d = await maestro('stats-membership-simulator')
  const m = await d.attach({
    device,
    platform: 'ios',
    appId: 'com.apple.mobilesafari',
    artifacts: 'on-failure',
    commandTimeout: 30000
  })
  try {
    const user = f.people.follower
    await f.h.db
      .updateTable('users')
      .set({
        onboarding_step: 'complete',
        onboarding_completed_at: new Date()
      })
      .where('id', '=', userIdOfGumbo(user))
      .execute()
    const game = f.games[0]
    await f.h.db
      .updateTable('games')
      .set({
        linescore: JSON.stringify({
          away: { runs: [1, 0, 2], r: 3, h: 4, e: 0 },
          home: { runs: [2, 1, 3], r: 6, h: 7, e: 0 }
        })
      })
      .where('id', '=', game.id)
      .execute()
    const next = `/games/${game.id}?tab=boxScore`
    const teamPath = `/teams/${f.teamA}?tab=stats`
    await m.openLink({ link: f.h.origin + teamPath })
    await m.assertVisible({ text: 'Log in / Sign up', timeout: 20000 })
    await m.assertNotVisible({ text: 'Close warning' })
    await capture(m, out, 'guest-team-stats.png')
    await m.openLink({ link: f.h.origin + next })
    await m.assertVisible({ text: 'Log in / Sign up', timeout: 20000 })
    await m.assertNotVisible({ text: 'Close warning' })
    await capture(m, out, 'guest-game-stats.png')
    await m.tapOn({ text: 'Log in / Sign up' })
    await m.tapOn({ text: 'E-mail address' })
    await m.inputText({ text: f.emails[user] })
    await m.pressKey({ key: 'ENTER' })
    await m.assertVisible({ text: 'Sign-in code', timeout: 10000 })
    const stored = await f.h.db
      .selectFrom('email_codes')
      .select('next_path')
      .where('email', '=', f.emails[user])
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow()
    expect(stored.next_path).equals(
      routePath(parseRoute(`/games/${game.id}`, next.split('?')[1]))
    )
    const link = f.h.links.get(f.emails[user])
    expect(link).not.equals(undefined)
    // Captured fixture email: open its real token in this fixture's server.
    await m.openLink({ link: f.h.origin + new URL(link!).pathname })
    await m.assertVisible({ text: 'Request membership', timeout: 20000 })
    await m.assertVisible({
      text: 'You need to be a member of one of these teams to see individual player stats.'
    })
    await m.assertNotVisible({ text: 'Close warning' })
    await m.assertNotVisible({ text: 'Log in / Sign up' })
    await capture(m, out, 'signed-in-game-stats.png')
    await m.openLink({ link: f.h.origin + teamPath })
    await m.assertVisible({ text: 'Request membership', timeout: 20000 })
    await capture(m, out, 'signed-in-team-stats.png')
    await m.tapOn({ text: 'Request membership' })
    await m.assertVisible({ text: 'Send request' })
    await m.assertNotVisible({ text: 'Close warning' })
    await m.tapOn({ text: 'Send request' })
    await m.assertVisible({ text: 'Membership request sent' })
    await capture(m, out, 'stats-request-sent.png')
    const pending = await f.h.db
      .selectFrom('group_requests')
      .select('status')
      .where('sender_id', '=', userIdOfGumbo(user))
      .where('kind', '=', 'membership')
      .executeTakeFirstOrThrow()
    expect(pending.status).equals('pending')
    const blocked = await f.h.request(
      'GET',
      `/videos/${game.videoId}/playback`,
      undefined,
      user
    )
    expect(blocked.status).equals(403)
    console.log(
      'Simulator verified inline guest/member actions on game and team stats, login return, and a pending membership request without a modal.'
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
