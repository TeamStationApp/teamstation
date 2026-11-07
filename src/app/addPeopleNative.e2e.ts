import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { groupFixture } from '../test/groupFixtures'
import { insertFixtureUsers } from '../test/insertFixtureUsers'
import { maestro } from '../test/refinementsMaestro.e2e'

async function main(): Promise<void> {
  const platform = process.env.TS_ADD_PEOPLE_PLATFORM
  const device = process.env.TS_ADD_PEOPLE_DEVICE
  const appFile = process.env.TS_ADD_PEOPLE_APP_FILE
  const host = process.env.TS_ADD_PEOPLE_HOST
  const artifacts = process.env.TS_ADD_PEOPLE_ARTIFACTS
  const work = process.env.TS_ADD_PEOPLE_WORK
  if (
    (platform !== 'ios' && platform !== 'android') ||
    device == null ||
    appFile == null ||
    host == null ||
    artifacts == null ||
    work == null
  )
    throw new Error(
      'Supply platform, owned device, app file, fixture host, artifacts and work directory'
    )
  await mkdir(work, { recursive: true })
  const portProbe = createServer()
  await new Promise<void>((resolve, reject) => {
    portProbe.once('error', reject)
    portProbe.listen(8081, '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    portProbe.close(error => {
      error == null ? resolve() : reject(error)
    })
  })
  const f = await groupFixture(undefined, host)
  const output = await open(join(work, 'metro.log'), 'w')
  const metro = spawn(
    resolve('node_modules/.bin/react-native'),
    ['start', '--port', '8081', '--reset-cache', '--no-interactive'],
    {
      env: {
        ...process.env,
        TS_API_BASE_URL: `${f.h.origin}/api/v1`,
        TS_APP_ORIGIN: ''
      },
      stdio: ['ignore', output.fd, output.fd]
    }
  )
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  try {
    daemon = await maestro('addMemberNative')
    await insertFixtureUsers(
      f.h.db,
      [0, 1, 2, 3, 4, 5].map(n => ({
        id: 400 + n,
        first_name: `Mookie${n}`,
        last_name: 'Betts',
        display_name: `Mookie${n} Betts`,
        login_enabled: true,
        email: `selection${n}@example.test`
      }))
    )
    await f.h.db
      .insertInto('memberships')
      .values(
        Array.from({ length: 6 }, (_, n) => ({
          id: makeId('membership'),
          team_id: f.teamB,
          user_id: userIdOfGumbo(400 + n),
          role: 'member' as const,
          is_player: true
        }))
      )
      .execute()
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        ready = (
          await (await fetch('http://127.0.0.1:8081/status')).text()
        ).includes('running')
      } catch {}
      if (ready) break
      await setTimeout(500)
    }
    assert.ok(ready, 'Task Metro starts')
    const m = await daemon.attach({
      device,
      platform,
      appId: 'app.teamstation.app',
      appFile,
      artifacts: 'on-failure',
      driverStartTimeout: 180,
      extra: platform === 'android' ? { androidTcpForward: true } : {}
    })
    const focusInput = async (label: string, index = 0): Promise<void> => {
      if (platform === 'ios') {
        await m.tapOn({ id: label })
        return
      }
      interface Node {
        type?: string
        bounds?: { x: number; y: number; width: number; height: number }
        children?: Node[]
      }
      const flatten = (node: Node): Node[] => [
        node,
        ...(node.children ?? []).flatMap(flatten)
      ]
      const nodes = flatten(await m.hierarchy())
      const fields = nodes.filter(
        node =>
          /TextField|EditText/.test(node.type ?? '') && node.bounds != null
      )
      const field = fields[index]?.bounds
      if (field == null) throw new Error('Native input missing')
      await m.command('tapOnPoint', {
        x: Math.round(field.x + field.width / 2),
        y: Math.round(field.y + field.height / 2)
      })
      await setTimeout(400)
    }
    const type = async (value: string): Promise<void> => {
      if (platform === 'android') {
        await m.inputText({ text: value })
        return
      }
      for (const character of value) {
        await m.inputText({ text: character })
        await setTimeout(80)
      }
    }
    await m.launchApp({ clearState: true })
    await m.assertVisible({ text: 'Send me a sign-in code', timeout: 120000 })
    await focusInput('E-mail address')
    await type('alex@example.com')
    await m.tapOn({ text: 'Send me a sign-in code', timeout: 15000 })
    for (
      let attempt = 0;
      attempt < 40 && !f.h.mail.has('alex@example.com');
      attempt++
    )
      await setTimeout(250)
    assert.ok(f.h.mail.has('alex@example.com'), 'Fixture receives sign-in code')
    await m.assertVisible({ text: 'Sign-in code', timeout: 15000 })
    await focusInput('Sign-in code', 1)
    await type(f.h.mail.get('alex@example.com')!)
    await m.hideKeyboard()
    const signInTree = JSON.stringify(await m.hierarchy())
    if (signInTree.includes('Sign-in code'))
      await m.tapOn({ text: 'Sign in', timeout: 15000 })
    await m.openLink({
      link: `teamstation://groups/team/${f.teamA}/settings/people`
    })
    await m.assertVisible({ text: 'Add People', timeout: 30000 })
    const base = process.argv.includes('--base')
    if (!base) {
      await focusInput('Search users')
      await type('Mookie')
      await m.assertVisible({ text: 'Select Mookie0 B', timeout: 15000 })
      interface ResultNode {
        id?: string
        bounds?: { x: number; y: number; width: number; height: number }
        children?: ResultNode[]
      }
      const findResults = (node: ResultNode): ResultNode | undefined =>
        node.id === 'account-search-results'
          ? node
          : node.children?.map(findResults).find(value => value != null)
      const bounds = findResults(await m.hierarchy())?.bounds
      assert.ok(bounds != null, 'Results panel has measured bounds')
      const x = Math.round(bounds.x + bounds.width / 2)
      await m.swipe({
        startX: x,
        startY: Math.round(bounds.y + bounds.height - 12),
        endX: x,
        endY: Math.round(bounds.y + 12),
        duration: 600
      })
      await m.waitForAnimationToEnd()
      await m.assertVisible({ text: 'Select Mookie4 B', timeout: 15000 })
      await writeFile(
        join(artifacts, `account-results-keyboard-${platform}.png`),
        await m.screenshot()
      )
      await m.tapOn({ text: 'Select Mookie4 B', timeout: 15000 })
      await m.hideKeyboard()
      await m.tapOn({ text: 'Remove Mookie4 B', timeout: 15000 })
      for (const n of [0, 1]) {
        await focusInput('Search users')
        await type(`Mookie${n}`)
        await m.tapOn({ text: `Select Mookie${n} B`, timeout: 15000 })
      }
      await focusInput('Search users')
      await type('Nobody')
      await m.assertVisible({ text: 'No accounts match', timeout: 15000 })
      await m.tapOn({ text: 'Close account results' })
      if (platform === 'android') {
        // The Android assertion driver can retain a removed portal node.
        // Read fresh hierarchy snapshots and still require actual absence.
        const deadline = Date.now() + 15000
        let result = findResults(await m.hierarchy())
        while (result != null && Date.now() < deadline) {
          await setTimeout(250)
          result = findResults(await m.hierarchy())
        }
        assert.equal(
          result,
          undefined,
          'Dismissed account results leave the hierarchy'
        )
      } else {
        await m.assertNotVisible({ id: 'account-search-results' })
      }
      await m.tapOn({ text: 'Clear Search users' })
      await m.hideKeyboard()
      await m.tapOn({ text: 'Remove Mookie0 B' })
      await focusInput('Search users')
      await type('Mookie0')
      await m.tapOn({ text: 'Select Mookie0 B', timeout: 15000 })
      await m.hideKeyboard()
    }
    await m.waitForAnimationToEnd()
    await writeFile(
      join(
        artifacts,
        `add-people-${platform}-${base ? 'before' : 'after'}.png`
      ),
      await m.screenshot()
    )
    if (!base) {
      await m.scrollUntilVisible({
        element: { id: 'add-people-submit' },
        centerElement: true,
        timeout: 15000
      })
      await m.tapOn({ id: 'add-people-submit' })
      await m.assertVisible({ text: '.*Added 2, invited 0.*', timeout: 20000 })
      const members = await f.h.db
        .selectFrom('memberships')
        .select('user_id')
        .where('team_id', '=', f.teamA)
        .where('user_id', 'in', [userIdOfGumbo(400), userIdOfGumbo(401)])
        .execute()
      assert.equal(members.length, 2)
    }
    await appendFile(
      join(artifacts, 'native-account-selection.log'),
      `$ node -r sucrase/register src/app/addPeopleNative.e2e.ts${base ? ' --base' : ''} (${platform})\nPASS: ${base ? 'baseline form' : 'search, fifth-result selection above keyboard, multi-select, removal, keyboard dismissal, account submission'}\n`
    )
  } finally {
    await daemon?.shutdown()
    metro.kill()
    await output.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
