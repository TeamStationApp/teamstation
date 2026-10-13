import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

async function main(): Promise<void> {
  const device = required('TEST_DEVICE')
  const appId = required('TEST_APP_ID')
  const artifacts = required('TEST_ARTIFACT_DIR')
  mkdirSync(artifacts, { recursive: true })
  const bin = required('MAESTRO_D_BIN')
  execFileSync(bin, ['ps'], { stdio: 'inherit' })
  const load = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )
  const { MaestroD } = load('maestro-d')
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D'), bin })
  let stopApp: (() => Promise<unknown>) | undefined
  try {
    const m = await daemon.attach({
      device,
      platform: 'ios',
      appId,
      noAppInstall: true
    })
    stopApp = async () => await m.stopApp({ appId })
    await m.launchApp({ appId })
    await m.assertVisible({ id: 'pinned-schedule-smoke-alive', timeout: 15000 })
    await m.assertVisible({ text: '.*vs Falcons.*', timeout: 10000 })
    for (let pass = 0; pass < 2; pass++) {
      await m.tapOn({ text: 'Videos' })
      await m.tapOn({ text: 'Schedule' })
      await m.assertVisible({ text: '.*vs Falcons.*', timeout: 10000 })
    }
    await m.swipe({ start: '50%,70%', end: '50%,35%', duration: 500 })
    await m.assertVisible({ id: 'pinned-schedule-smoke-alive' })
    writeFileSync(join(artifacts, 'ios-schedule.png'), await m.screenshot())
    console.log('iOS schedule anchor, repeated tab entry and scrolling passed')
  } finally {
    await stopApp?.().catch(() => undefined)
    await daemon.detach(device).catch(() => undefined)
    await daemon.shutdown()
    daemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
