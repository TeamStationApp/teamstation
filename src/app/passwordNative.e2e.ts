import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import path from 'node:path'

import { userIdOfGumbo } from '../common/userId'
import { type AccountHarness, accountHarness } from '../test/accountHarness'
import {
  testPasswordKdf,
  testPasswordParameters
} from '../test/passwordFixtures'

async function main(): Promise<void> {
  const device = process.env.PASSWORD_SIMULATOR_UDID
  const artifacts = process.env.TS_ACCOUNT_ARTIFACTS
  const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
  const appFile = process.env.PASSWORD_BENCHMARK_APP
  const daemonName = process.env.MAESTRO_D
  assert(
    device != null &&
      artifacts != null &&
      clientRoot != null &&
      appFile != null &&
      daemonName != null,
    'Set PASSWORD_SIMULATOR_UDID, TS_ACCOUNT_ARTIFACTS, MAESTRO_D_CLIENT_ROOT, PASSWORD_BENCHMARK_APP and MAESTRO_D'
  )
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js')
  let complete!: (result: Record<string, unknown>) => void
  let timer: ReturnType<typeof setTimeout>
  const resultPromise = new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      complete = resolve
      timer = setTimeout(() => {
        reject(new Error('Native benchmark did not complete'))
      }, 120000)
    }
  )
  // Handle timeout even if driver setup fails before the benchmark starts.
  resultPromise.catch(() => undefined)
  let h: AccountHarness | undefined
  let detach: (() => Promise<void>) | undefined
  try {
    h = await accountHarness(undefined, (app, fixture) => {
      app.get('/benchmark', (_req, res) =>
        res.json({
          token: fixture.tokens.get(101),
          email: 'alex@example.com',
          userId: userIdOfGumbo(101)
        })
      )
      app.post('/benchmark/result', (req, res) => {
        complete(req.body)
        res.json({ ok: true })
      })
    })
    const daemon = await MaestroD.connect({ name: daemonName })
    const m = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'app.teamstation.app',
      appFile,
      artifacts: 'on-failure'
    })
    detach = async () => {
      await m.detach()
    }
    await m.launchApp({ clearState: true })
    await m.assertVisible({ text: 'Native Argon2id benchmark', timeout: 30000 })
    await m.tapOn({ id: 'benchmark-server' })
    await m.inputText({ text: h.origin })
    if (process.env.PASSWORD_BENCHMARK_ITERATIONS != null) {
      await m.tapOn({ id: 'benchmark-iterations' })
      await m.eraseText({ characters: 10 })
      await m.inputText({ text: process.env.PASSWORD_BENCHMARK_ITERATIONS })
    }
    await m.hideKeyboard()
    await m.tapOn({ text: 'Run benchmark' })
    const result = await resultPromise
    assert.equal(
      result.vector,
      await testPasswordKdf('Argon2 parity: é😀', testPasswordParameters),
      'native/WASM vector parity'
    )
    assert.equal(
      result.signedIn,
      true,
      'native client set/login through real API'
    )
    assert.deepEqual(
      result.unicodeRequirements,
      {
        length: true,
        uppercase: true,
        lowercase: true,
        number: true,
        long: false,
        tooLong: false,
        valid: true
      },
      'Unicode password requirements in the native JavaScript runtime'
    )
    await mkdir(artifacts, { recursive: true })
    await writeFile(
      path.join(artifacts, 'native-calibration.png'),
      await m.screenshot()
    )
    await writeFile(
      path.join(artifacts, 'native-calibration.log'),
      [
        '$ node -r sucrase/register src/app/passwordNative.e2e.ts (pinned iPhone simulator, Release build)',
        `Host processor: ${cpus()[0]?.model}; simulator timing is not physical-phone timing.`,
        'Native compiled C output matches browser WASM; native client set-password and login succeed against real server/database.',
        JSON.stringify(result, null, 2)
      ].join('\n') + '\n'
    )
    console.log(JSON.stringify(result))
    if (process.env.PASSWORD_REQUIRE_TARGET === '1')
      assert(
        Number(result.median) >= 1950 && Number(result.median) <= 4050,
        'target median 3000 ms ±35%'
      )
  } finally {
    clearTimeout(timer!)
    try {
      await detach?.()
    } finally {
      await h?.close()
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
