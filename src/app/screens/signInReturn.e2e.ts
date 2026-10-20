import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { userIdOfGumbo } from '../../common/userId'
import { guardianFixture } from '../../test/guardianFixture'
import { capture, maestro } from '../../test/refinementsMaestro.e2e'
import { routePath } from '../navigation/routes'

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
  const d = await maestro('signin-return-simulator')
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
    const secondId = 'vid_signin_outfield'
    const original = await f.h.db
      .selectFrom('videos')
      .selectAll()
      .where('id', '=', game.videoId)
      .executeTakeFirstOrThrow()
    await f.h.db
      .insertInto('videos')
      .values({
        ...original,
        id: secondId,
        title: 'Game — Outfield'
      })
      .execute()
    for (const [key, value] of [...f.h.objects])
      if (key.includes(game.videoId))
        f.h.objects.set(key.replace(game.videoId, secondId), value)
    await m.openLink({
      link:
        f.h.origin + `/games/${game.id}?tab=watch&video=${game.videoId}&t=42`
    })
    await m.assertVisible({ text: 'Play game video', timeout: 20000 })
    await m.tapOn({ text: 'Outfield' })
    await capture(m, out, 'guest-game.png')
    await m.tapOn({ text: 'Play game video' })
    await m.assertVisible({ text: 'Log in / Sign up' })
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
      routePath({
        name: 'game',
        gameId: game.id,
        tab: 'watch',
        videoId: secondId,
        at: 0
      })
    )
    const link = f.h.links.get(f.emails[user])
    expect(link).not.equals(undefined)
    // Captured fixture email: open its real token in this fixture's server.
    await m.openLink({ link: f.h.origin + new URL(link!).pathname })
    await m.assertVisible({ text: 'Play game video', timeout: 20000 })
    await m.assertNotVisible({ text: 'Request membership' })
    await capture(m, out, 'signed-in-same-game.png')
    await m.tapOn({ text: 'Play game video' })
    await m.assertVisible({ text: 'Request membership' })
    await m.assertNotVisible({ text: 'Log in / Sign up' })
    await capture(m, out, 'signed-in-membership-warning.png')
    const blocked = await f.h.request(
      'GET',
      `/videos/${secondId}/playback`,
      undefined,
      user
    )
    expect(blocked.status).equals(403)
    console.log(
      'Simulator verified email sign-in returns to the selected nondefault camera and prompts for membership on playback.'
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
