import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const localRequire = createRequire(__filename)
const clientRequire =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? localRequire
    : createRequire(
        join(resolve(process.env.MAESTRO_D_CLIENT_ROOT), 'package.json')
      )
const { MaestroD } = clientRequire('maestro-d')

/** Drive the real native scoring field, never standalone picker buttons. */
async function main(): Promise<void> {
  const baseline = process.env.SCORING_NATIVE_BASELINE === '1'
  const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
  await mkdir(artifacts, { recursive: true })
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const m = await daemon.attach({
    device: required('SCORING_DEVICE_UDID'),
    platform: 'ios',
    appId: required('SCORING_APP_ID'),
    artifacts: 'on-failure'
  })
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text: `^${text}$`, timeout: 15000 })
  }
  const capture = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await writeFile(join(artifacts, `${name}.png`), await m.screenshot())
    await writeFile(
      join(artifacts, `${name}.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
  }
  const fieldReady = async (): Promise<void> => {
    await m.assertVisible({ text: '^Assign P$', timeout: 60000 })
    await m.assertVisible({ text: '^Assign LF$', timeout: 15000 })
    for (const name of [
      'Mike T',
      'Shohei O',
      'Aaron J',
      'Bryce H',
      'Freddie F',
      'Juan S',
      'Bobby W'
    ])
      await m.assertVisible({ text: `^${name}$`, timeout: 15000 })
  }
  try {
    await m.stopApp({})
    await m.launchApp({ permissions: { all: 'unset' } })
    await m.assertVisible({
      text: 'Missing defensive positions',
      timeout: 60000
    })
    const start = Date.now()
    await fieldReady()
    console.log(`Field ready ${Date.now() - start}ms after setup warning`)
    await capture('field-ready')
    await tap('Assign P')
    await m.assertVisible({
      text: baseline ? '^Assign P$' : '^Assign pitcher$',
      timeout: 15000
    })
    await capture('field-tap-picker')
    if (baseline) {
      await m.assertNotVisible({ text: '^Assign pitcher$' })
      await tap('Cancel')
      await fieldReady()
      await capture('field-after-cancel')
      console.log(
        'PASS baseline: complete native field, all position labels, actual empty-position tap and return'
      )
      return
    }
    await m.assertVisible({ text: '^Bench$' })
    await m.assertVisible({ text: '^Fielders$' })
    await tap('Create Player')
    await m.assertVisible({ text: '^First Name$' })
    await tap('Cancel')
    await m.assertVisible({ text: '^Assign pitcher$' })
    await tap('Create Player')
    for (const [label, value] of [
      ['First Name', 'Clayton'],
      ['Last Name', 'Kershaw'],
      ['Jersey Number', '22']
    ]) {
      await tap(label)
      await m.inputText({ text: value })
    }
    await m.hideKeyboard()
    await tap('Create Player')
    await m.assertVisible({ text: '^Assign pitcher$' })
    await m.assertVisible({ text: 'Assign P #22 Clayton K' })
    await capture('created-player-return')
    await tap('Create Player')
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await tap('Throws')
    await m.hideKeyboard()
    await m.swipe({ start: '25%, 55%', end: '25%, 20%', duration: 400 })
    await m.scrollUntilVisible({
      element: { text: '^Create Placeholder Player$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Create Placeholder Player')
    await m.assertVisible({ text: '^Select number of players to create\\.$' })
    await tap('Create')
    await m.assertVisible({ text: '^Assign pitcher$' })
    await m.assertVisible({ text: 'Assign P Hawks A' })
    await capture('placeholder-return')
    await m.scrollUntilVisible({
      element: { text: 'Assign P #27 Mike T' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Assign P #27 Mike T')
    await m.assertVisible({ text: '^Assign C$', timeout: 15000 })
    await capture('catcher-vacated')
    await tap('Assign C')
    await m.assertVisible({ text: '^Assign catcher$' })
    await tap('Assign C #22 Clayton K')
    await m.assertNotVisible({ text: '^Assign C$', timeout: 15000 })
    await m.assertVisible({ text: '^Clayton Kershaw$', timeout: 15000 })
    await tap('Clayton Kershaw')
    await m.assertVisible({ text: '^Assign catcher$', timeout: 15000 })
    await capture('occupied-fielder-tap')
    await tap('Cancel')
    await tap('Assign LF')
    await m.assertVisible({ text: '^Assign left field$' })
    await tap('Assign LF #50 Mookie B')
    await m.assertNotVisible({
      text: 'Missing defensive positions',
      timeout: 15000
    })
    await m.assertVisible({ text: '^Mookie B$', timeout: 15000 })
    await capture('complete-defense')
    await tap('Ball')
    await m.assertVisible({ text: '^Undo Ball$', timeout: 15000 })
    // A history entry alone does not prove the native presentation finished.
    await m.assertVisible({ text: '^Ball$', enabled: true, timeout: 60000 })
    await capture('pitch-rendered')
    // This tap must reach the live scene after the animation, not a stale label.
    await tap('Clayton Kershaw')
    await m.assertVisible({ text: '^Assign catcher$', timeout: 15000 })
    await capture('field-after-pitch-picker')
    await tap('Cancel')
    await tap('Undo Ball')
    await m.assertVisible({ text: '^Undo Set team roster$', timeout: 15000 })
    await m.assertVisible({ text: '^Mookie B$', timeout: 15000 })
    await capture('pitch-undone')
    console.log(
      'PASS current: full native field; empty and occupied field taps; create/cancel/placeholder return; substitution/vacancy; complete defense clears warning; pitch rendering and Undo'
    )
  } finally {
    if (process.env.SCORING_KEEP_ATTACHED !== '1') await m.detach()
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
