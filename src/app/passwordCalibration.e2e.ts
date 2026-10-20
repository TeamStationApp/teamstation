import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { readPasswordRecord } from '../server/auth/passwords'
import { accountHarness } from '../test/accountHarness'
import { testPasswordKdf } from '../test/passwordFixtures'

async function main(): Promise<void> {
  const artifacts = process.env.TS_ACCOUNT_ARTIFACTS
  const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
  assert(
    artifacts != null && clientRoot != null,
    'Set TS_ACCOUNT_ARTIFACTS and MAESTRO_D_CLIENT_ROOT'
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const h = await accountHarness(path.resolve('dist'), (app, fixture) => {
    app.get('/fixture', (_req, res) => {
      res.cookie('ts_session', fixture.tokens.get(101), { httpOnly: true })
      res.redirect('/account')
    })
  })
  let m: any
  try {
    const d = await MaestroD.connect({
      name: process.env.MAESTRO_D ?? 'passwordCalibrationWeb'
    })
    m = await d.attach({
      device: 'web',
      platform: 'web',
      url: h.origin + '/fixture',
      extra: { windowSize: '1100,1000' },
      artifacts: 'none'
    })
    await m.openLink({ link: h.origin + '/fixture' })
    await m.assertVisible({ text: 'Set password', timeout: 30000 })
    const fill = async (label: string, value: string): Promise<void> => {
      await m.tapOn({ css: `input[aria-label="${label}"]` })
      await m.eraseText({ characters: 1100 })
      await m.tapOn({ css: `input[aria-label="${label}"]` })
      await m.inputText({ text: value })
      await m.assertVisible({
        css: `input[aria-label="${label}"][value="${value}"]`
      })
    }
    await m.tapOn({ text: 'Set password' })
    await fill('New password', 'abc')
    await fill('Confirm new password', 'xyz')
    await m.assertVisible({ text: 'Passwords do not match' })
    await fill('New password', 'Example8')
    await fill('Confirm new password', 'Example8')
    await m.assertVisible({ text: '✓ Passwords match' })
    await mkdir(artifacts, { recursive: true })
    await writeFile(
      path.join(artifacts, 'browser-form-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Save password' })
    await m.assertVisible({ text: 'Password saved', timeout: 60000 })
    const records: unknown[] = []
    const record = async (): Promise<void> => {
      const row = await h.db
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', userIdOfGumbo(101))
        .executeTakeFirstOrThrow()
      const saved = readPasswordRecord(row.password_hash)!
      assert.equal(saved.client.memoryKiB, 32768)
      assert.equal(saved.client.parallelism, 4)
      assert(saved.client.iterations >= 6)
      assert.equal(saved.server.iterations, saved.client.iterations * 4)
      records.push({
        client: {
          memoryKiB: saved.client.memoryKiB,
          iterations: saved.client.iterations,
          parallelism: saved.client.parallelism
        },
        serverIterations: saved.server.iterations
      })
    }
    await record()
    await m.tapOn({ text: 'Change password' })
    await fill('Current password', 'Example8')
    await fill('New password', 'abcdefghijklmnop')
    await fill('Confirm new password', 'abcdefghijklmnop')
    await m.assertVisible({
      css: '[aria-label="An uppercase letter: Required"]'
    })
    await fill('New password', 'abcdefghijklmnopq')
    await fill('Confirm new password', 'abcdefghijklmnopq')
    await m.assertVisible({
      css: '[aria-label="An uppercase letter: Not required with 17 or more characters"]'
    })
    await m.tapOn({ text: 'Save password' })
    await m.assertVisible({ text: 'Password saved', timeout: 60000 })
    await record()
    await m.tapOn({ text: 'Change password' })
    await m.tapOn({ text: 'Reset with an email code' })
    await m.assertVisible({ css: 'input[aria-label="Password reset code"]' })
    const code = h.mail.get('alex@example.com')
    assert(code != null, 'reset email delivered')
    await fill('Password reset code', code)
    await fill('New password', 'Another9')
    await fill('Confirm new password', 'Another9')
    await m.tapOn({ text: 'Save password' })
    await m.assertVisible({ text: 'Password saved', timeout: 60000 })
    await record()
    const login = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      passwordKdf: testPasswordKdf
    })
    assert.equal(
      (await login.signInWithPassword('alex@example.com', 'Another9')).user.id,
      101
    )
    await writeFile(
      path.join(artifacts, 'browser-calibration.log'),
      [
        '$ node -r sucrase/register src/app/passwordCalibration.e2e.ts',
        'Finished web UI: incomplete requirements, mismatch/match, eight-character password, 16/17-character waiver, calibrated set/change/email-reset and final sign-in passed.',
        'Real browser Worker/WASM, HTTP routes, PostgreSQL and native server hashing. Synthetic test account only.',
        JSON.stringify(records, null, 2)
      ].join('\n') + '\n'
    )
  } catch (error) {
    try {
      if (m != null) {
        await mkdir(path.join(artifacts, 'support'), { recursive: true })
        await writeFile(
          path.join(artifacts, 'support', 'browser-failure.json'),
          JSON.stringify(await m.hierarchy(), null, 2)
        )
      }
    } catch {
      // Diagnostics are best effort; preserve the original test failure.
    }
    throw error
  } finally {
    try {
      await m?.detach()
    } finally {
      await h.close()
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
