import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
async function main(): Promise<void> {
  const artifacts = process.env.TS_ACCOUNT_ARTIFACTS
  const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
  const device = process.env.PASSWORD_SIMULATOR_UDID
  const appFile = process.env.PASSWORD_BENCHMARK_APP
  assert(
    artifacts != null &&
      clientRoot != null &&
      device != null &&
      appFile != null,
    'Set artifact, maestro client, simulator and benchmark app environment variables'
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const d = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'passwordCalibration'
  })
  const m = await d.attach({
    device,
    platform: 'ios',
    appId: 'app.teamstation.app',
    appFile,
    artifacts: 'none'
  })
  try {
    await m.launchApp({ clearState: true })
    await m.tapOn({ text: 'Show password form' })
    await m.tapOn({ text: 'Set password' })
    async function fill(label: string, value: string): Promise<void> {
      await m.tapOn({ text: label })
      await m.eraseText({ characters: 100 })
      await m.inputText({ text: value })
      await m.hideKeyboard()
    }
    await fill('New password', 'Example8')
    await fill('Confirm new password', 'Example8')
    await m.scrollUntilVisible({
      element: { text: 'Save password' },
      direction: 'down'
    })
    await writeFile(
      artifacts + '/password-form-after.png',
      await m.screenshot()
    )
    await fill('New password', 'abc')
    await fill('Confirm new password', 'xyz')
    await writeFile(
      artifacts + '/password-incomplete-after.png',
      await m.screenshot()
    )
    await fill('New password', 'abcdefghijklmnopq')
    await fill('Confirm new password', 'abcdefghijklmnopq')
    await writeFile(
      artifacts + '/password-long-after.png',
      await m.screenshot()
    )
    await m.assertVisible({
      text: 'A number: Not required with 17 or more characters'
    })
    await m.tapOn({ text: 'Save password' })
    await m.assertVisible({ text: 'Password saved', timeout: 30000 })
    await m.launchApp({ clearState: true })
    await m.tapOn({ text: 'Show pending password form' })
    await m.tapOn({ text: 'Set password' })
    await m.scrollUntilVisible({
      element: { text: 'Preparing password security… You can keep typing.' },
      direction: 'down'
    })
    await writeFile(artifacts + '/password-preparing.png', await m.screenshot())
    await m.launchApp({ clearState: true })
    await m.tapOn({ text: 'Show failed password form' })
    await m.tapOn({ text: 'Set password' })
    await m.scrollUntilVisible({
      element: { text: 'Retry password preparation' },
      direction: 'down'
    })
    await writeFile(artifacts + '/password-retry.png', await m.screenshot())
  } finally {
    await m.detach()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
