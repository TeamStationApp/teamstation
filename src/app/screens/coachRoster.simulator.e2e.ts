import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { dictatingHealth } from '../../test/dictationFakes'
import { guardianFixture } from '../../test/guardianFixture'
import { capture, maestro } from '../../test/refinementsMaestro.e2e'

/** Real player-settings routes and persistence in Safari on a simulator only. */
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
  const f = await guardianFixture(resolve('dist'), undefined, app => {
    app.get('/api/v1/health', (_req, res) => {
      dictatingHealth()
        .then(value => res.json(value))
        .catch(() => res.sendStatus(500))
    })
  })
  const d = await maestro('coach-roster-simulator')
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
      .where('id', '=', user)
      .execute()
    const game = f.games[0]
    const path = `/games/${game.id}/coach/${f.teamA}`
    await m.openLink({
      link: f.h.origin + '/sign-in?next=' + encodeURIComponent(path)
    })
    await m.tapOn({ text: 'E-mail address' })
    await m.inputText({ text: f.emails[user] })
    await m.pressKey({ key: 'ENTER' })
    await m.assertVisible({ text: 'Sign-in code', timeout: 10000 })
    const link = f.h.links.get(f.emails[user])!
    await m.openLink({ link: f.h.origin + new URL(link).pathname })
    await m.assertVisible({ text: 'Save Rosters', timeout: 20000 })
    await m.tapOn({ text: 'Roster', index: 0 })
    await m.assertNotVisible({
      text: 'Player settings are unavailable for this team.'
    })
    await capture(m, out, 'coach-roster-footer.png')
    // The visible cards expose the settings action on their accessibility label.
    const tree = await m.hierarchy()
    await writeFile(
      join(out, 'roster-hierarchy.json'),
      JSON.stringify(tree, null, 2)
    )
    await m.tapOn({ text: '.*edit settings.*', index: 0 })
    await m.assertVisible({ text: 'Jersey number', timeout: 10000 })
    await m.tapOn({ text: 'Jersey number' })
    await m.command('eraseText', { characters: 20 })
    await m.inputText({ text: '42' })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Save', index: 0 })
    await m.assertVisible({ text: 'Saved.' })
    await capture(m, out, 'coach-player-settings-saved.png')
    const saved = await f.h.db
      .selectFrom('memberships')
      .select('user_id')
      .where('team_id', '=', f.teamA)
      .where('jersey', '=', '42')
      .execute()
    expect(saved).length(1)
    await m.tapOn({ text: 'Cancel', index: 0 })
    await m.assertVisible({ text: '.*jersey 42.*' })
    await m.openLink({ link: f.h.origin + path })
    await m.assertVisible({ text: 'Save Rosters', timeout: 20000 })
    await m.tapOn({ text: 'Roster', index: 0 })
    await m.assertVisible({ text: '.*jersey 42.*' })
    await capture(m, out, 'coach-roster-reopened.png')
    console.log(
      'PASS simulator coaching roster settings, real save/reopen persistence, and footer capture'
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
