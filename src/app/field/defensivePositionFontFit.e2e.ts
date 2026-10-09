import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const localRequire = createRequire(__filename)
const client =
  process.env.MAESTRO_D_CLIENT_ROOT != null
    ? createRequire(
        join(resolve(process.env.MAESTRO_D_CLIENT_ROOT), 'package.json')
      )
    : localRequire
const { MaestroD } = client('maestro-d')
const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
async function main(): Promise<void> {
  const device = required('SCORING_DEVICE_UDID')
  const mode = required('FONT_FIT_PLATFORM')
  assert(['ios', 'android', 'safari'].includes(mode))
  const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const appId =
    mode === 'safari' ? 'com.apple.mobilesafari' : 'app.teamstation.fontfit'
  const m = await daemon.attach({
    device,
    platform: mode === 'android' ? 'android' : 'ios',
    appId,
    appFile: mode === 'android' ? process.env.FONT_FIT_APP_FILE : undefined,
    artifacts: 'on-failure'
  })
  await mkdir(artifacts, { recursive: true })
  let restoreFont: (() => void) | undefined
  const capture = async (size: string): Promise<void> => {
    for (const position of ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'])
      await m.assertVisible({ text: `^(Assign )?${position}$`, timeout: 15000 })
    await writeFile(
      join(artifacts, `${mode}-${size}.png`),
      await m.screenshot()
    )
    await writeFile(
      join(artifacts, `${mode}-${size}.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
    console.log(
      `PASS ${mode} ${size}: all nine labels visible; screenshot captured`
    )
  }
  try {
    await m.stopApp({ appId })
    await m.launchApp({ appId })
    if (mode === 'safari')
      await m.openLink({ link: required('SCORING_TEST_URL'), browser: true })
    await m.assertVisible({
      text: 'Missing defensive positions',
      timeout: 60000
    })
    await m.tapOn({ text: '^OK$', optional: true, timeout: 1000 })
    await capture('normal')
    const before = process.env.FONT_FIT_SIZE_BEFORE
    if (mode !== 'safari' && before != null) {
      assert(/^[a-z0-9.-]+$/.test(before), 'Invalid font-size setting')
      // SDK configuration only; app lifecycle, assertions and capture use maestro-d.
      const configure = (size: string): void => {
        if (mode === 'ios')
          execFileSync('xcrun', ['simctl', 'ui', device, 'content_size', size])
        else
          execFileSync('adb', [
            '-s',
            device,
            'shell',
            'settings',
            'put',
            'system',
            'font_scale',
            size
          ])
      }
      restoreFont = () => {
        configure(before)
      }
      configure(mode === 'ios' ? 'extra-extra-extra-large' : '1.3')
      await m.stopApp({ appId })
      await m.launchApp({ appId })
      await m.assertVisible({
        text: 'Missing defensive positions',
        timeout: 60000
      })
      await capture('large-text')
    }
  } finally {
    restoreFont?.()
    await m.detach()
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
