/** Physical-device proof against quietStreamNativeFixture.e2e.ts. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Supply ${name}`)
  return value
}

async function main(): Promise<void> {
  const device = required('QUIET_STREAM_DEVICE_UDID')
  const origin = required('QUIET_STREAM_ORIGIN')
  const artifacts = required('QUIET_STREAM_ARTIFACTS')
  const { MaestroD } = require(required('MAESTRO_D_CLIENT_ROOT'))
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const appId = 'app.teamstation.app.quietqa'
  const m = await daemon.attach({
    device,
    platform: 'ios',
    appId,
    teamId: required('MAESTRO_IOS_TEAM_ID')
  })
  const control = async (action: string): Promise<void> => {
    const response = await fetch(`${origin}/__quiet/${action}`, {
      method: 'POST'
    })
    assert.equal(response.status, 200, action)
  }
  const state = async (): Promise<{
    state: string
    closes_at: string | null
  }> => await (await fetch(`${origin}/__quiet/state`)).json()
  await mkdir(artifacts, { recursive: true })
  try {
    // Finish an interrupted previous run before making a fresh fixture.
    await control('reset')
    await control('automatic')
    await m.stopApp({ appId })
    await m.launchApp({ appId })
    await m.assertVisible({ text: '^Watch live$', timeout: 20000 })
    await writeFile(join(artifacts, 'iphone-live.png'), await m.screenshot())
    console.log('PASS: physical iPhone home shows the synthetic live game')
    // Leave the initial state on screen for the independently captured bench clip.
    await new Promise(resolve => setTimeout(resolve, 5000))
    await control('expire')
    assert.equal((await state()).state, 'ended')
    await m.assertNotVisible({ text: '^Watch live$', timeout: 20000 })
    await m.assertVisible({ text: '^Watch$', timeout: 20000 })
    await writeFile(join(artifacts, 'iphone-ended.png'), await m.screenshot())
    console.log(
      'PASS: both clocks end the stream; home loses LIVE over the real socket'
    )
    await m.tapOn({ text: '^Watch$' })
    await m.assertVisible({ text: '(^|, )Ended$', timeout: 20000 })
    await m.assertVisible({ text: '^Watch full screen$', timeout: 20000 })
    await new Promise(resolve => setTimeout(resolve, 5000))
    await writeFile(
      join(artifacts, 'iphone-playback.png'),
      await m.screenshot()
    )
    console.log('PASS: the retained recording opens in the native player')
    await m.tapOn({ text: '^Back$' })
    await control('manual')
    // A newly seeded game did not exist when this home subscription opened.
    await m.stopApp({ appId })
    await m.launchApp({ appId })
    await m.assertVisible({ text: '^Watch live$', timeout: 20000 })
    await m.tapOn({ text: '^Watch live$' })
    await m.tapOn({ text: '^More for Camera 1$', timeout: 20000 })
    await m.tapOn({ text: '^End$' })
    assert.notEqual((await state()).closes_at, null)
    await control('tick')
    assert.equal((await state()).state, 'ended')
    await m.assertVisible({ text: '(^|, )Ended$', timeout: 20000 })
    await m.tapOn({ text: '^Back$' })
    await m.assertNotVisible({ text: '^Watch live$', timeout: 20000 })
    console.log(
      'PASS: native End action closes a fresh stream before either clock'
    )
  } finally {
    await m.detach()
    daemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
